/**
 * MPP surface — the second payment rail alongside x402.
 *
 *   /api/mandate     MPP charge + multi-recipient SPLIT   (one-time: enroll a
 *                    standing execution mandate; 10% shared with the research/
 *                    signal partner whose convictions drive the desk)
 *   /session/desk    MPP session channel                  (deposit once, then
 *                    pay per execution with off-chain vouchers)
 *
 * Together with the x402 routes (exact/upto), Oddsmith exercises the full OKX
 * Agent Payments Protocol surface.
 */
import type { Request as ExReq, Response as ExRes } from "express";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Mppx } from "@okxweb3/mpp";
import { SaApiClient } from "@okxweb3/mpp/evm";
import { charge, session } from "@okxweb3/mpp/evm/server";
import { USDT0 } from "../chain/xlayer.js";

const CHAIN_ID = 196;
const ESCROW = process.env.MPP_ESCROW ?? "0x5E550002e64FaF79B41D89fE8439eEb1be66CE3b";

type MppResult =
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt: (res: Response) => Response };

interface MppLike {
  charge: (opts: unknown) => (req: Request) => Promise<MppResult>;
  session: (opts: unknown) => (req: Request) => Promise<MppResult>;
}

let cached: MppLike | null = null;

function mpp(): MppLike {
  if (cached) return cached;
  const saClient = new SaApiClient({
    apiKey: process.env.OKX_API_KEY!,
    secretKey: process.env.OKX_SECRET_KEY!,
    passphrase: process.env.OKX_PASSPHRASE!,
    ...(process.env.OKX_BASE_URL ? { baseUrl: process.env.OKX_BASE_URL } : {}),
  });
  const signer = privateKeyToAccount(process.env.MPP_MERCHANT_PRIVATE_KEY as Hex);
  cached = Mppx.create({
    methods: [charge({ saClient }), session({ saClient, signer })],
    realm: process.env.MPP_REALM ?? "oddsmith.desk",
    secretKey: process.env.MPP_SECRET_KEY!,
  }) as unknown as MppLike;
  return cached;
}

function toWeb(req: ExReq): Request {
  const url = `https://${req.headers.host ?? "localhost"}${req.originalUrl}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(","));
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    init.body = JSON.stringify(req.body ?? {});
  }
  return new Request(url, init);
}

async function send(res: ExRes, webRes: Response): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.send(await webRes.text());
}

/** One-time execution-mandate enrollment, paid via MPP charge, split with the signal partner. */
export async function mandateEnrollHandler(req: ExReq, res: ExRes): Promise<void> {
  const partner = process.env.SPLIT_PARTNER;
  const chargeOpts = {
    amount: "50000", // 0.05 USDt0 (6 decimals)
    currency: USDT0,
    recipient: process.env.PAY_TO!,
    description: "Oddsmith standing execution mandate",
    methodDetails: {
      chainId: CHAIN_ID,
      feePayer: true,
      splits: partner ? [{ amount: "5000", recipient: partner, memo: "signal partner" }] : undefined,
    },
  };
  try {
    const result = await mpp().charge(chargeOpts)(toWeb(req));
    if (result.status === 402) return send(res, result.challenge);
    const reqBody = req.body as { subject?: string; agent?: string } | undefined;
    const subject = reqBody?.subject ?? reqBody?.agent ?? null;
    return send(res, result.withReceipt(Response.json({ enrolled: true, subject })));
  } catch (e) {
    res.status(500).json({ error: `mandate charge failed: ${(e as Error).message}` });
  }
}

/** Pay-per-execution channel: deposit once, then fire executions against off-chain vouchers. */
export async function deskSessionHandler(req: ExReq, res: ExRes): Promise<void> {
  const sessionOpts = {
    amount: "20000", // unit price: 0.02 USDt0 per execution - matches /api/execute
    currency: USDT0,
    recipient: process.env.PAY_TO!,
    description: "Oddsmith desk - per-execution channel",
    unitType: "execution",
    suggestedDeposit: "200000", // ~10 executions
    methodDetails: {
      chainId: CHAIN_ID,
      escrowContract: ESCROW,
      feePayer: true,
      minVoucherDelta: "0",
    },
  };
  try {
    const result = await mpp().session(sessionOpts)(toWeb(req));
    if (result.status === 402) return send(res, result.challenge);
    return send(res, result.withReceipt(Response.json({ ok: true })));
  } catch (e) {
    res.status(500).json({ error: `desk session failed: ${(e as Error).message}` });
  }
}
