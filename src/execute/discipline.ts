/**
 * The execution desk's discipline layer - the difference between Oddsmith and a
 * thin "swap this now" wrapper.
 *
 * A conviction arrives with a stake and, optionally, the caller's price ceiling
 * and fair-value estimate. Before anything is signed, this decides whether the
 * trade is worth making at the *current* quoted price, and checks it against hard
 * risk ceilings. Every rule fails closed: on any doubt it refuses.
 */
import { config } from "../config.js";

export interface Conviction {
  /** The asset to buy into (symbol or address), for reporting. */
  asset: string;
  /** USD stake requested. Capped by config.maxStakePerTradeUsd. */
  amountUsd: number;
  /** Price ceiling in USDt0 per token. Never pay above it. Optional. */
  maxPrice?: number;
  /** Caller's fair-value estimate in USDt0 per token. If given, drives the edge check. */
  fairValue?: number;
  /** Requested slippage tolerance (percent). Capped by config.maxSlippagePercent. */
  slippagePercent?: number;
}

export interface QuoteView {
  /** Current quoted price in USDt0 per token. */
  price: number;
  /** Target-token units the stake would buy at that price. */
  toAmount: number;
}

export interface Order {
  asset: string;
  amountUsd: number;
  slippagePercent: number;
  /** The quoted price this order was approved against. */
  expectedPrice: number;
}

export type Decision =
  | { approved: true; order: Order; edge: number | null; rationale: string }
  | { approved: false; reason: string; edge: number | null };

/**
 * Decide whether to execute, and how.
 *
 * @param spentTodayUsd cumulative stake already deployed live today (for the daily cap).
 */
export function decide(conviction: Conviction, q: QuoteView, spentTodayUsd: number): Decision {
  const { amountUsd } = conviction;
  const slippage = conviction.slippagePercent ?? config.defaultSlippagePercent;
  const edge = conviction.fairValue != null ? conviction.fairValue - q.price : null;

  // 1. Stake sanity + per-trade ceiling. Never silently trim - refuse and say so.
  if (!(amountUsd > 0)) {
    return { approved: false, reason: "Stake must be greater than zero.", edge };
  }
  if (amountUsd > config.maxStakePerTradeUsd) {
    return {
      approved: false,
      reason: `Stake $${amountUsd.toFixed(2)} exceeds the per-trade ceiling of $${config.maxStakePerTradeUsd.toFixed(2)}.`,
      edge,
    };
  }

  // 2. Daily cumulative ceiling.
  if (spentTodayUsd + amountUsd > config.maxStakePerDayUsd) {
    return {
      approved: false,
      reason: `Stake $${amountUsd.toFixed(2)} would take today's deployed total to $${(spentTodayUsd + amountUsd).toFixed(2)}, past the daily ceiling of $${config.maxStakePerDayUsd.toFixed(2)}.`,
      edge,
    };
  }

  // 3. Slippage ceiling.
  if (slippage > config.maxSlippagePercent) {
    return {
      approved: false,
      reason: `Requested slippage ${slippage}% exceeds the ${config.maxSlippagePercent}% ceiling.`,
      edge,
    };
  }

  // 4. Never chase: refuse if the asset is already trading above your price ceiling.
  if (conviction.maxPrice != null && q.price > conviction.maxPrice) {
    return {
      approved: false,
      reason: `${conviction.asset} is quoting ${q.price.toFixed(6)} USDt0, above your ${conviction.maxPrice.toFixed(6)} ceiling - the move is already priced in, no edge left to capture.`,
      edge,
    };
  }

  // 5. Edge gate (only when the caller supplied a fair value).
  if (edge != null && edge <= 0) {
    return {
      approved: false,
      reason: `Your fair value ${conviction.fairValue!.toFixed(6)} is at or below the quoted price ${q.price.toFixed(6)} - no positive edge, so the desk holds.`,
      edge,
    };
  }

  const edgeNote = edge != null ? ` (edge ${edge.toFixed(6)} USDt0/token vs quote ${q.price.toFixed(6)})` : ` at quote ${q.price.toFixed(6)}`;
  return {
    approved: true,
    order: { asset: conviction.asset, amountUsd, slippagePercent: slippage, expectedPrice: q.price },
    edge,
    rationale: `Buy ${conviction.asset} with $${amountUsd.toFixed(2)} USDt0 at ${slippage}% slippage${edgeNote}.`,
  };
}
