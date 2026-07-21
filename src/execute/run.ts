/**
 * Execution orchestrator — the full loop behind POST /api/execute.
 *
 *   conviction  ->  resolve to a live market + outcome  ->  discipline check
 *               ->  (live + confirmed) real fill  |  (else) dry-run preview
 *
 * "No manual hop": the caller passes a thesis, a coin+window, or an explicit
 * market — Oddsmith finds the exact market, reads the live price, applies the
 * desk's discipline, and fires. It executes only what it is explicitly told to;
 * it never invents a position or gives unsolicited advice.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { decide, type Conviction, type Decision, type ResolvedLeg } from "./discipline.js";
import { saveExecution, spentTodayUsd } from "../store.js";
import {
  buy,
  checkAccess,
  getMarket,
  list5m,
  listMarkets,
  type AccessResult,
  type BuyResult,
} from "./polymarket.js";

export interface ExecuteRequest {
  /** Explicit market: slug or 0x condition_id. Highest resolution precedence. */
  market?: string;
  /** 5-minute Up/Down market coin (BTC, ETH, SOL, XRP, BNB, DOGE, HYPE). */
  coin?: string;
  /** Time window for a recurring market. Currently "5m". */
  window?: string;
  /** Natural-language thesis, keyword-resolved to a market. Lowest precedence. */
  thesis?: string;
  /** Outcome to buy: yes / no / up / down, or a categorical label. */
  outcome: string;
  amountUsd: number;
  maxPrice?: number;
  fairProbability?: number;
  /** Caller's explicit go-ahead for a real on-chain fill. Live mode requires it. */
  confirm?: boolean;
}

export interface ResolvedMarket {
  conditionId: string;
  question: string;
  slug?: string;
  endDate?: string;
}

export interface ExecutionReport {
  id: string;
  at: string;
  mode: "live" | "paper";
  /** true only when a real on-chain order was placed (never in paper mode). */
  filled: boolean;
  status: string;
  access: AccessResult | null;
  market: ResolvedMarket | null;
  decision: { approved: boolean; reason?: string; rationale?: string; edge: number | null };
  order: { tokenId: string; outcome: string; amountUsd: number; price?: number; orderType: string } | null;
  fill: { orderId?: string; shares?: number; limitPrice?: number; txHashes: string[] } | null;
  strategyId: string;
}

export class ExecuteRequestError extends Error {}

/** Map a requested outcome label to a token id + live price from a market's tokens. */
function pickLeg(
  tokens: Array<{ outcome: string; token_id: string; price: number; best_ask?: number }>,
  outcome: string,
): ResolvedLeg | null {
  const want = outcome.trim().toLowerCase();
  const t = tokens.find((x) => x.outcome.trim().toLowerCase() === want);
  if (!t) return null;
  return { tokenId: t.token_id, outcome: t.outcome, price: t.price, bestAsk: t.best_ask };
}

async function resolve(req: ExecuteRequest): Promise<{ market: ResolvedMarket; leg: ResolvedLeg }> {
  const outcome = req.outcome?.trim().toLowerCase();

  // (a) 5-minute Up/Down coin market — resolve to the current accepting round.
  if (req.coin && (req.window ?? "5m").toLowerCase() === "5m") {
    const markets = await list5m(req.coin, 5);
    const m = markets.find((x) => x.acceptingOrders) ?? markets[0];
    if (!m) throw new ExecuteRequestError(`No 5-minute market found for ${req.coin}.`);
    if (outcome !== "up" && outcome !== "down") {
      throw new ExecuteRequestError(`5-minute markets take outcome "up" or "down", got "${req.outcome}".`);
    }
    const leg: ResolvedLeg =
      outcome === "up"
        ? { tokenId: m.upTokenId, outcome: "up", price: m.upPrice }
        : { tokenId: m.downTokenId, outcome: "down", price: m.downPrice };
    return { market: { conditionId: m.conditionId, question: m.question, slug: m.slug, endDate: m.endDateUtc }, leg };
  }

  // (b) Explicit market by slug / condition_id.
  if (req.market) {
    const detail = await getMarket(req.market);
    const leg = pickLeg(detail.tokens, req.outcome);
    if (!leg) {
      throw new ExecuteRequestError(
        `Outcome "${req.outcome}" not found in market. Available: ${detail.tokens.map((t) => t.outcome).join(", ")}.`,
      );
    }
    return { market: { conditionId: detail.condition_id, question: detail.question, endDate: detail.end_date }, leg };
  }

  // (c) Natural-language thesis — keyword resolve, then read the book.
  if (req.thesis) {
    const hits = await listMarkets(req.thesis, 5);
    const top = hits.find((h) => h.accepting_orders) ?? hits[0];
    if (!top) throw new ExecuteRequestError(`No market matched thesis: "${req.thesis}".`);
    const detail = await getMarket(top.condition_id ?? top.slug);
    const leg = pickLeg(detail.tokens, req.outcome);
    if (!leg) {
      throw new ExecuteRequestError(
        `Resolved "${top.question}" but outcome "${req.outcome}" not found. Available: ${detail.tokens.map((t) => t.outcome).join(", ")}.`,
      );
    }
    return { market: { conditionId: detail.condition_id, question: detail.question, slug: top.slug, endDate: detail.end_date }, leg };
  }

  throw new ExecuteRequestError("Provide one of: market, coin (+window), or thesis.");
}

export interface PreviewReport {
  at: string;
  market: ResolvedMarket;
  outcome: string;
  marketPrice: number;
  decision: { approved: boolean; reason?: string; rationale?: string; edge: number | null };
  recommendedOrder: { tokenId: string; outcome: string; amountUsd: number; price?: number; orderType: string } | null;
}

/**
 * Resolve + discipline WITHOUT executing — the read behind /api/resolve and the
 * free demo. Shows the exact market, the live price, and what the desk would do,
 * so a caller (or a judge) sees the decision before any money moves.
 */
export async function previewExecution(req: ExecuteRequest): Promise<PreviewReport> {
  if (!req.outcome || typeof req.outcome !== "string") throw new ExecuteRequestError("outcome is required.");
  const amountUsd = typeof req.amountUsd === "number" && Number.isFinite(req.amountUsd) ? req.amountUsd : 1;
  const { market, leg } = await resolve(req);
  const decision = decide(
    { outcome: leg.outcome, amountUsd, maxPrice: req.maxPrice, fairProbability: req.fairProbability },
    leg,
    spentTodayUsd(),
  );
  return {
    at: new Date().toISOString(),
    market,
    outcome: leg.outcome,
    marketPrice: leg.price,
    decision: decision.approved
      ? { approved: true, rationale: decision.rationale, edge: decision.edge }
      : { approved: false, reason: decision.reason, edge: decision.edge },
    recommendedOrder: decision.approved ? { ...decision.order } : null,
  };
}

export async function runExecution(req: ExecuteRequest): Promise<ExecutionReport> {
  if (!req.outcome || typeof req.outcome !== "string") throw new ExecuteRequestError("outcome is required.");
  if (typeof req.amountUsd !== "number" || !Number.isFinite(req.amountUsd)) {
    throw new ExecuteRequestError("amountUsd must be a number.");
  }

  const id = randomUUID();
  const at = new Date().toISOString();
  const wantLive = config.live && req.confirm === true;

  // Region gate — never execute a real fill from a restricted region.
  let access: AccessResult | null = null;
  if (wantLive) {
    access = await checkAccess().catch(() => ({ accessible: null, warning: "check-access unreachable" }) as AccessResult);
    if (access.accessible === false) {
      const report: ExecutionReport = {
        id, at, mode: "live", filled: false, status: "blocked_region", access,
        market: null, decision: { approved: false, reason: `Region restricted (${access.country ?? "unknown"}) — execution refused.`, edge: null },
        order: null, fill: null, strategyId: config.strategyId,
      };
      saveExecution(report);
      return report;
    }
  }

  const { market, leg } = await resolve(req);

  const conviction: Conviction = {
    outcome: leg.outcome,
    amountUsd: req.amountUsd,
    maxPrice: req.maxPrice,
    fairProbability: req.fairProbability,
  };
  const decision: Decision = decide(conviction, leg, spentTodayUsd());

  if (!decision.approved) {
    const report: ExecutionReport = {
      id, at, mode: wantLive ? "live" : "paper", filled: false, status: "held",
      access, market, decision: { approved: false, reason: decision.reason, edge: decision.edge },
      order: null, fill: null, strategyId: config.strategyId,
    };
    saveExecution(report);
    return report;
  }

  const { order } = decision;
  const dryRun = !wantLive;
  let buyResult: BuyResult;
  try {
    buyResult = await buy({
      tokenId: order.tokenId,
      outcome: order.outcome,
      amountUsd: order.amountUsd,
      price: order.price,
      orderType: order.orderType,
      dryRun,
    });
  } catch (e) {
    const msg = (e as { message?: string }).message ?? String(e);
    const report: ExecutionReport = {
      id, at, mode: dryRun ? "paper" : "live", filled: false, status: "execution_error",
      access, market,
      decision: { approved: true, rationale: decision.rationale, edge: decision.edge },
      order: { ...order }, fill: null, strategyId: config.strategyId,
    };
    saveExecution(report);
    // Surface the underlying reason without pretending a fill happened.
    (report as ExecutionReport & { error?: string }).error = msg;
    return report;
  }

  const txHashes = Array.isArray(buyResult.tx_hashes) ? buyResult.tx_hashes : [];
  const filled = !dryRun && txHashes.length > 0;

  const report: ExecutionReport = {
    id, at,
    mode: dryRun ? "paper" : "live",
    filled,
    status: dryRun ? "preview" : (buyResult.status ?? (filled ? "matched" : "submitted")),
    access, market,
    decision: { approved: true, rationale: decision.rationale, edge: decision.edge },
    order: { ...order },
    fill: {
      orderId: buyResult.order_id,
      shares: typeof buyResult.shares === "number" ? buyResult.shares : undefined,
      limitPrice: typeof buyResult.limit_price === "number" ? buyResult.limit_price : order.price,
      txHashes,
    },
    strategyId: config.strategyId,
  };
  saveExecution(report);
  return report;
}
