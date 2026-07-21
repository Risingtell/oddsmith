/**
 * Oddsmith — the execution desk for prediction-market agents.
 *
 * Your research agent has the conviction; Oddsmith pulls the trigger. It takes a
 * thesis (or a specific market + outcome), resolves it to a live Polymarket
 * market, applies the desk's discipline (never chase, size under hard caps),
 * fires a real on-chain fill, and returns the position with proof.
 *
 * Payment surfaces (settled in USDt0 on X Layer, eip155:196, via OKX APP):
 *   POST /api/execute    x402 exact   $0.05   resolve + discipline + real fill
 *   POST /api/resolve    x402 exact   $0.01   resolve + odds + what the desk would do (no fill)
 *   POST /api/positions  x402 exact   $0.01   open positions + live PnL
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
import { runExecution, previewExecution, ExecuteRequestError, type ExecuteRequest } from "./execute/run.js";
import { getPositions } from "./execute/polymarket.js";
import { mandateEnrollHandler, deskSessionHandler } from "./payments/mpp.js";
import { rateLimited } from "./demo/rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO = process.env.PAY_TO ?? "0x0000000000000000000000000000000000000000";
const NETWORK = "eip155:196" as const; // X Layer mainnet — the only supported network

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

// Mirror the deterministic PaymentRequired object into the JSON body as well as
// the header — some client SDKs read the challenge from the body to complete the
// replay handshake. (Same fix Argus's OKX review required.)
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

const executeAccepts = { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.05", maxTimeoutSeconds: 600 };
const resolveAccepts = { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.01", maxTimeoutSeconds: 300 };
const positionsAccepts = { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.01", maxTimeoutSeconds: 300 };

const EXECUTE_DESCRIPTION =
  "Execute a prediction-market conviction as a disciplined, real Polymarket fill. " +
  'Body: {"outcome":"up|down|yes|no", "amountUsd":5, ' +
  'one of: "coin":"BTC" (5-minute Up/Down) | "market":"<slug-or-0x-conditionId>" | "thesis":"<keyword>", ' +
  'optional "maxPrice":0.6, "fairProbability":0.7, "confirm":true}. ' +
  "The desk refuses to buy above maxPrice (never chases) and enforces hard per-trade/daily stake caps. " +
  "A real on-chain fill needs confirm:true and the service in live mode; otherwise returns a dry-run preview.";
const RESOLVE_DESCRIPTION =
  "Resolve a conviction to a live market and show what the desk would do, without executing. " +
  'Body: same as /api/execute (outcome + one of coin/market/thesis). Returns the resolved market, live price, edge, and the recommended order.';
const POSITIONS_DESCRIPTION =
  'Open Polymarket positions with live PnL for the desk wallet. Body: {} or {"address":"0x..."}.';

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
  // Marketplace validators (OKX's x402-check) probe an unpaid GET before a paid
  // POST — answer the same 402 challenge on GET so the probe passes.
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
      console.log(`Facilitator ready — paid surfaces live on X Layer (${NETWORK}).`);
      return;
    } catch (e) {
      const wait = Math.min(60_000, 2_000 * attempt);
      console.warn(`Facilitator init failed (attempt ${attempt}): ${(e as Error).message}. Retrying in ${wait / 1000}s.`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));

// Free discovery route — also the URL the marketplace listing points at.
app.get("/", (_req, res) =>
  res.json({
    name: "Oddsmith",
    tagline: "The execution desk for prediction-market agents",
    paymentsReady,
    executionMode: config.executionMode,
    surfaces: {
      execute: `POST /api/execute — $0.05 x402/exact — ${EXECUTE_DESCRIPTION}`,
      resolve: `POST /api/resolve — $0.01 x402/exact — ${RESOLVE_DESCRIPTION}`,
      positions: `POST /api/positions — $0.01 x402/exact — ${POSITIONS_DESCRIPTION}`,
      mandate: "POST /api/mandate — MPP charge+split — enroll a standing execution mandate",
      desk: "POST /session/desk — MPP session — pay-per-execution channel",
    },
    protocols: ["x402: exact, upto", "MPP: charge (+splits), session"],
    venue: "Polymarket (Polygon, chain 137)",
    settlement: "service fee in USDt0 on X Layer (eip155:196)",
    risk: {
      maxStakePerTradeUsd: config.maxStakePerTradeUsd,
      maxStakePerDayUsd: config.maxStakePerDayUsd,
      neverBuyAbovePrice: config.defaultMaxPrice,
    },
  }),
);

app.get("/healthz", (_req, res) => res.json({ ok: true, paymentsReady, executionMode: config.executionMode }));

app.get("/site", (_req, res) => res.sendFile(path.join(__dirname, "../public/site.html")));

// Free, rate-limited demo — resolve a live 5-minute market and show what the
// desk would do. No payment, no wallet, no facilitator dependency.
app.post("/api/demo/resolve", async (req, res) => {
  const key = req.ip ?? "unknown";
  if (rateLimited(key)) return res.status(429).json({ error: "Rate limited — try again in a minute." });
  const body = (req.body ?? {}) as ExecuteRequest;
  const demoReq: ExecuteRequest = {
    coin: body.coin ?? "BTC",
    window: "5m",
    outcome: body.outcome ?? "up",
    amountUsd: typeof body.amountUsd === "number" ? body.amountUsd : 1,
    maxPrice: body.maxPrice,
    fairProbability: body.fairProbability,
  };
  try {
    res.json(await previewExecution(demoReq));
  } catch (e) {
    if (e instanceof ExecuteRequestError) return res.status(400).json({ error: e.message });
    res.status(502).json({ error: `resolve failed: ${(e as Error).message}` });
  }
});

// Guard paid POSTs until the facilitator has loaded.
app.use((req, res, next) => {
  if (!paymentsReady && req.method === "POST") {
    return res.status(503).json({ error: "payment facilitator initializing — retry shortly", paymentsReady });
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

app.post("/api/positions", async (req, res) => {
  const { address } = (req.body ?? {}) as { address?: string };
  try {
    res.json({ positions: await getPositions(address) });
  } catch (e) {
    res.status(502).json({ error: `positions failed: ${(e as Error).message}` });
  }
});

// MPP-gated routes (self-handle their own 402).
app.post("/api/mandate", mandateEnrollHandler);
app.post("/session/desk", deskSessionHandler);

app.listen(PORT, () => {
  console.log(`Oddsmith desk on :${PORT} — discovery live, warming facilitator (${NETWORK})…`);
  void initWithRetry();
});
