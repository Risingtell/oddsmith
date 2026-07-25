/**
 * Execution orchestrator - the full loop behind POST /api/execute.
 *
 *   conviction  ->  resolve asset + live OKX DEX quote  ->  discipline check
 *               ->  (live + confirmed) real swap  |  (else) dry-run preview
 *
 * "No manual hop": the caller states an asset and a stake; Oddsmith resolves the
 * token on X Layer, reads the live quote, applies the desk's discipline, and
 * fires a real swap on the OKX DEX aggregator. It executes only what it is
 * explicitly told to; it never invents a position or gives unsolicited advice.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { decide, type Conviction, type Decision, type QuoteView } from "./discipline.js";
import { saveExecution, spentTodayUsd } from "../store.js";
import { deskAddress, executeSwap, quote, resolveToken, type TokenInfo } from "./okxdex.js";

export interface ExecuteRequest {
  /** Asset to buy into: a token symbol (e.g. "OKB") or a 0x address on X Layer. */
  asset: string;
  /** USD stake (in USDt0) to deploy. */
  amountUsd: number;
  /** Price ceiling in USDt0 per token. Never pay above it. */
  maxPrice?: number;
  /** Your own fair-value estimate in USDt0 per token - drives the edge check. */
  fairValue?: number;
  /** Slippage tolerance (percent). Capped by the desk's maximum. */
  slippagePercent?: number;
  /** Caller's explicit go-ahead for a real on-chain swap. Live mode requires it. */
  confirm?: boolean;
}

export interface ExecutionReport {
  id: string;
  at: string;
  mode: "live" | "paper";
  /** true only when a real on-chain swap settled (never in paper mode). */
  filled: boolean;
  status: string;
  asset: { symbol: string; address: string } | null;
  quote: { price: number; toAmount: number } | null;
  decision: { approved: boolean; reason?: string; rationale?: string; edge: number | null };
  order: { asset: string; amountUsd: number; slippagePercent: number; expectedPrice: number } | null;
  fill: { txHash: string; block: string; toAmount: number; price: number } | null;
}

export class ExecuteRequestError extends Error {}

async function resolveAndQuote(req: ExecuteRequest): Promise<{ token: TokenInfo; view: QuoteView }> {
  const token = await resolveToken(req.asset);
  const amountUsd = req.amountUsd > 0 ? req.amountUsd : 1;
  const q = await quote(token, amountUsd);
  return { token, view: { price: q.price, toAmount: q.toAmount } };
}

export interface PreviewReport {
  at: string;
  asset: { symbol: string; address: string };
  price: number;
  toAmount: number;
  decision: { approved: boolean; reason?: string; rationale?: string; edge: number | null };
  recommendedOrder: { asset: string; amountUsd: number; slippagePercent: number; expectedPrice: number } | null;
}

/**
 * Resolve + discipline WITHOUT executing - the read behind /api/resolve and the
 * free demo. Shows the asset, the live quote, and what the desk would do.
 */
export async function previewExecution(req: ExecuteRequest): Promise<PreviewReport> {
  if (!req.asset || typeof req.asset !== "string") throw new ExecuteRequestError("asset is required.");
  const amountUsd = typeof req.amountUsd === "number" && Number.isFinite(req.amountUsd) ? req.amountUsd : 1;
  const { token, view } = await resolveAndQuote({ ...req, amountUsd });
  const conviction: Conviction = { asset: token.symbol, amountUsd, maxPrice: req.maxPrice, fairValue: req.fairValue, slippagePercent: req.slippagePercent };
  const decision = decide(conviction, view, spentTodayUsd());
  return {
    at: new Date().toISOString(),
    asset: { symbol: token.symbol, address: token.address },
    price: view.price,
    toAmount: view.toAmount,
    decision: decision.approved
      ? { approved: true, rationale: decision.rationale, edge: decision.edge }
      : { approved: false, reason: decision.reason, edge: decision.edge },
    recommendedOrder: decision.approved ? { ...decision.order } : null,
  };
}

export async function runExecution(req: ExecuteRequest): Promise<ExecutionReport> {
  if (!req.asset || typeof req.asset !== "string") throw new ExecuteRequestError("asset is required.");
  if (typeof req.amountUsd !== "number" || !Number.isFinite(req.amountUsd)) {
    throw new ExecuteRequestError("amountUsd must be a number.");
  }

  const id = randomUUID();
  const at = new Date().toISOString();
  const wantLive = config.live && req.confirm === true;

  const { token, view } = await resolveAndQuote(req);
  const conviction: Conviction = {
    asset: token.symbol,
    amountUsd: req.amountUsd,
    maxPrice: req.maxPrice,
    fairValue: req.fairValue,
    slippagePercent: req.slippagePercent,
  };
  const decision: Decision = decide(conviction, view, spentTodayUsd());

  const baseReport: ExecutionReport = {
    id, at, mode: wantLive ? "live" : "paper", filled: false, status: "held",
    asset: { symbol: token.symbol, address: token.address },
    quote: { price: view.price, toAmount: view.toAmount },
    decision: { approved: false, edge: decision.edge },
    order: null, fill: null,
  };

  if (!decision.approved) {
    const report = { ...baseReport, decision: { approved: false, reason: decision.reason, edge: decision.edge } };
    saveExecution(report);
    return report;
  }

  const { order } = decision;

  if (!wantLive) {
    const report: ExecutionReport = {
      ...baseReport, mode: "paper", status: "preview",
      decision: { approved: true, rationale: decision.rationale, edge: decision.edge },
      order: { ...order }, fill: null,
    };
    saveExecution(report);
    return report;
  }

  try {
    const swap = await executeSwap(token, order.amountUsd, order.slippagePercent);
    const report: ExecutionReport = {
      ...baseReport, mode: "live", filled: swap.status === "success",
      status: swap.status === "success" ? "filled" : "reverted",
      decision: { approved: true, rationale: decision.rationale, edge: decision.edge },
      order: { ...order },
      fill: { txHash: swap.txHash, block: swap.block, toAmount: swap.toAmount, price: swap.price },
    };
    saveExecution(report);
    return report;
  } catch (e) {
    const report: ExecutionReport = {
      ...baseReport, mode: "live", status: "execution_error",
      decision: { approved: true, rationale: decision.rationale, edge: decision.edge },
      order: { ...order }, fill: null,
    };
    (report as ExecutionReport & { error?: string }).error = (e as Error).message;
    saveExecution(report);
    return report;
  }
}

export { deskAddress };
