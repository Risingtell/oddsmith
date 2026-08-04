/**
 * Oddsmith - the execution desk for on-chain trading agents, native to X Layer.
 *
 * Your research agent has the conviction; Oddsmith pulls the trigger. It takes an
 * asset and a stake, reads the live OKX DEX quote on X Layer, applies the desk's
 * discipline (never chase, size under hard caps), and fires a real swap - USDt0
 * into the conviction, settled in OKB gas. Nothing leaves the OKX ecosystem.
 *
 * Payment surfaces (settled in USDt0 on X Layer, eip155:196, via OKX APP):
 *   POST /api/execute    x402 exact   $0.02   resolve + discipline + real swap
 *   POST /api/resolve    x402 exact   $0.01   resolve + live quote + what the desk would do
 *   POST /api/positions  x402 exact   $0.01   the desk's recent executions
 *   POST /api/mandate    MPP charge+split     standing execution mandate
 *   POST /session/desk   MPP session          pay-per-execution channel
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  paymentMiddlewareFromHTTPServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { UptoEvmScheme } from "@okxweb3/x402-evm/upto/server";
import { config } from "./config.js";
import { runExecution, previewExecution, deskAddress, ExecuteRequestError, type ExecuteRequest } from "./execute/run.js";
import { listExecutions } from "./store.js";
import { listDeskFills } from "./chain/fills.js";
import { mandateEnrollHandler, deskSessionHandler } from "./payments/mpp.js";
import { rateLimited } from "./demo/rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fail loudly at boot rather than silently serving broken payment surfaces —
// a missing PAY_TO must never fall back to a default, since it would quote a
// real burn address in every 402 challenge with buyer funds unrecoverable.
function requireEnv(names: string[]): void {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")} - refusing to start.`);
    process.exit(1);
  }
}
requireEnv(["PAY_TO", "OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "MPP_MERCHANT_PRIVATE_KEY", "MPP_SECRET_KEY"]);
if (process.env.PAY_TO === "0x0000000000000000000000000000000000000000") {
  console.error("PAY_TO is the zero address - refusing to start (payments would be unrecoverable).");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO = process.env.PAY_TO!;
const NETWORK = "eip155:196" as const; // X Layer mainnet - the only supported network

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
  syncSettle: true,
  ...(process.env.OKX_BASE_URL ? { baseUrl: process.env.OKX_BASE_URL } : {}),
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .register(NETWORK, new UptoEvmScheme());

function mirrorChallengeInBody(
  accepts: { scheme: string; network: typeof NETWORK; payTo: string; price: string; maxTimeoutSeconds: number },
  description: string,
  mimeType: string,
) {
  return async (context: { adapter: { getUrl(): string } }) => {
    const requirements = await resourceServer.buildPaymentRequirementsFromOptions([accepts], context);
    const paymentRequired = await resourceServer.createPaymentRequiredResponse(
      requirements,
      { url: context.adapter.getUrl(), description, mimeType },
      "Payment required",
    );
    return { contentType: "application/json", body: paymentRequired };
  };
}

const executeAccepts = { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.02", maxTimeoutSeconds: 600 };
const resolveAccepts = { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.01", maxTimeoutSeconds: 300 };
const positionsAccepts = { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.01", maxTimeoutSeconds: 300 };

const EXECUTE_DESCRIPTION =
  "Execute a trading conviction as a disciplined, real swap on the OKX DEX aggregator (X Layer). " +
  'Body: {"asset":"OKB", "amountUsd":1, optional "maxPrice":90, "fairValue":95, "slippagePercent":1, "confirm":true}. ' +
  "asset is a token symbol or 0x address on X Layer; the desk swaps USDt0 into it. " +
  "It refuses to buy above maxPrice (never chases) and enforces hard per-trade/daily stake caps. " +
  "A real on-chain swap needs confirm:true and the service in live mode; otherwise returns a dry-run preview.";
const RESOLVE_DESCRIPTION =
  "Resolve a conviction to a live OKX DEX quote and show what the desk would do, without executing. " +
  'Body: {"asset":"OKB", "amountUsd":1, optional "maxPrice", "fairValue", "slippagePercent"}. Returns the token, live price, edge, and recommended order.';
const POSITIONS_DESCRIPTION = "The desk's recent executions (asset, stake, price, tx). Body: {}.";

const httpServer = new x402HTTPResourceServer(resourceServer, {
  "POST /api/execute": {
    description: EXECUTE_DESCRIPTION,
    mimeType: "application/json",
    accepts: executeAccepts,
    unpaidResponseBody: mirrorChallengeInBody(executeAccepts, EXECUTE_DESCRIPTION, "application/json"),
  },
  "POST /api/resolve": {
    description: RESOLVE_DESCRIPTION,
    mimeType: "application/json",
    accepts: resolveAccepts,
    unpaidResponseBody: mirrorChallengeInBody(resolveAccepts, RESOLVE_DESCRIPTION, "application/json"),
  },
  // OKX's x402-check probes an unpaid GET before a paid POST - answer the same 402.
  "GET /api/execute": {
    description: EXECUTE_DESCRIPTION,
    mimeType: "application/json",
    accepts: executeAccepts,
    unpaidResponseBody: mirrorChallengeInBody(executeAccepts, EXECUTE_DESCRIPTION, "application/json"),
  },
  "POST /api/positions": {
    description: POSITIONS_DESCRIPTION,
    mimeType: "application/json",
    accepts: positionsAccepts,
    unpaidResponseBody: mirrorChallengeInBody(positionsAccepts, POSITIONS_DESCRIPTION, "application/json"),
  },
});

const app = express();
app.set("trust proxy", true);
app.use(express.json());

let paymentsReady = false;

async function initWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await httpServer.initialize();
      paymentsReady = true;
      console.log(`Facilitator ready - paid surfaces live on X Layer (${NETWORK}).`);
      return;
    } catch (e) {
      const wait = Math.min(60_000, 2_000 * attempt);
      console.warn(`Facilitator init failed (attempt ${attempt}): ${(e as Error).message}. Retrying in ${wait / 1000}s.`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));

app.get("/", (_req, res) =>
  res.json({
    name: "Oddsmith",
    tagline: "The execution desk for on-chain trading agents",
    paymentsReady,
    executionMode: config.executionMode,
    deskWallet: deskAddress(),
    surfaces: {
      execute: `POST /api/execute - $0.02 x402/exact - ${EXECUTE_DESCRIPTION}`,
      resolve: `POST /api/resolve - $0.01 x402/exact - ${RESOLVE_DESCRIPTION}`,
      positions: `POST /api/positions - $0.01 x402/exact - ${POSITIONS_DESCRIPTION}`,
      mandate: "POST /api/mandate - MPP charge+split - enroll a standing execution mandate",
      desk: "POST /session/desk - MPP session - pay-per-execution channel",
    },
    protocols: ["x402: exact, upto", "MPP: charge (+splits), session"],
    venue: "OKX DEX aggregator (X Layer, eip155:196)",
    settlement: "USDt0 on X Layer, OKB gas - fully native to the OKX ecosystem",
    risk: {
      maxStakePerTradeUsd: config.maxStakePerTradeUsd,
      maxStakePerDayUsd: config.maxStakePerDayUsd,
      maxSlippagePercent: config.maxSlippagePercent,
    },
  }),
);

app.get("/healthz", (_req, res) => res.json({ ok: true, paymentsReady, executionMode: config.executionMode }));

app.get("/site", (_req, res) => res.sendFile(path.join(__dirname, "../public/site.html")));

// Free, rate-limited demo - resolve a real asset quote and show what the desk
// would do. No payment, no wallet, no facilitator dependency.
app.post("/api/demo/resolve", async (req, res) => {
  const key = req.ip ?? "unknown";
  if (rateLimited(key)) return res.status(429).json({ error: "Rate limited - try again in a minute." });
  const body = (req.body ?? {}) as ExecuteRequest;
  const demoReq: ExecuteRequest = {
    asset: body.asset ?? "OKB",
    amountUsd: typeof body.amountUsd === "number" ? body.amountUsd : 1,
    maxPrice: body.maxPrice,
    fairValue: body.fairValue,
    slippagePercent: body.slippagePercent,
  };
  try {
    res.json(await previewExecution(demoReq));
  } catch (e) {
    if (e instanceof ExecuteRequestError) return res.status(400).json({ error: e.message });
    res.status(502).json({ error: `resolve failed: ${(e as Error).message}` });
  }
});

app.use((req, res, next) => {
  if (!paymentsReady && req.method === "POST") {
    return res.status(503).json({ error: "payment facilitator initializing - retry shortly", paymentsReady });
  }
  next();
});

app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

app.post("/api/execute", async (req, res) => {
  const body = (req.body ?? {}) as ExecuteRequest;
  try {
    res.json(await runExecution(body));
  } catch (e) {
    if (e instanceof ExecuteRequestError) return res.status(400).json({ error: e.message });
    res.status(502).json({ error: `execute failed: ${(e as Error).message}` });
  }
});

app.post("/api/resolve", async (req, res) => {
  const body = (req.body ?? {}) as ExecuteRequest;
  try {
    res.json(await previewExecution(body));
  } catch (e) {
    if (e instanceof ExecuteRequestError) return res.status(400).json({ error: e.message });
    res.status(502).json({ error: `resolve failed: ${(e as Error).message}` });
  }
});

app.post("/api/positions", async (_req, res) => {
  // Read the fills back from X Layer, not from this host's log: the desk may run
  // on an ephemeral filesystem, and a buyer paying for execution history must get
  // the real record rather than whatever survived the last restart.
  const desk = deskAddress();
  if (!desk) return res.status(503).json({ error: "desk wallet not configured" });
  try {
    const fills = await listDeskFills(desk as `0x${string}`);
    const local = new Map(listExecutions().filter((e) => e.fill?.txHash).map((e) => [e.fill!.txHash.toLowerCase(), e]));
    const executions = fills.map((f) => {
      const detail = local.get(f.txHash.toLowerCase());
      return detail ? { ...f, asset: detail.asset?.symbol, price: detail.fill?.price, at: detail.at } : f;
    });
    res.json({ deskWallet: desk, source: "x-layer chain data", count: executions.length, executions: executions.slice(-25) });
  } catch (e) {
    res.status(502).json({ error: `positions lookup failed: ${(e as Error).message}` });
  }
});

app.post("/api/mandate", mandateEnrollHandler);
app.post("/session/desk", deskSessionHandler);

app.listen(PORT, () => {
  console.log(`Oddsmith desk on :${PORT} - discovery live, warming facilitator (${NETWORK})...`);
  void initWithRetry();
});
