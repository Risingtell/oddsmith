/**
 * The execution desk's discipline layer — the difference between Oddsmith and a
 * thin "place this order" wrapper.
 *
 * A conviction arrives with a stake and (optionally) the caller's own fair-value
 * estimate. Before anything is signed, this decides whether the trade is worth
 * making at the *current* market price, and sizes it inside hard risk ceilings.
 * Every rule fails closed: on any doubt it refuses rather than fires.
 */
import { config } from "../config.js";

export interface Conviction {
  /** Outcome to buy: yes / no / up / down, or a categorical label. */
  outcome: string;
  /** USD stake requested. Capped by config.maxStakePerTradeUsd. */
  amountUsd: number;
  /** Caller's price ceiling (0-1). Never pay above it. Defaults to config.defaultMaxPrice. */
  maxPrice?: number;
  /** Caller's own probability estimate (0-1). If given, drives the edge check. */
  fairProbability?: number;
}

export interface ResolvedLeg {
  tokenId: string;
  outcome: string;
  /** Current best executable price for this outcome (0-1). */
  price: number;
  /** Best ask, if known — used to pick order type. */
  bestAsk?: number;
}

export interface Order {
  tokenId: string;
  outcome: string;
  amountUsd: number;
  /** Limit price (0-1) when a resting/limit order is chosen; omit for a market (FOK) order. */
  price?: number;
  orderType: "GTC" | "FOK";
}

export type Decision =
  | { approved: true; order: Order; edge: number | null; rationale: string }
  | { approved: false; reason: string; edge: number | null };

/** Round a probability to the CLOB's 2-decimal price grid without ever rounding UP past the ceiling. */
function floorToCent(p: number): number {
  return Math.floor(p * 100) / 100;
}

/**
 * Decide whether to execute, and how.
 *
 * @param spentTodayUsd cumulative stake already deployed today (for the daily cap).
 */
export function decide(conviction: Conviction, leg: ResolvedLeg, spentTodayUsd: number): Decision {
  const { amountUsd } = conviction;
  const ceiling = Math.min(conviction.maxPrice ?? config.defaultMaxPrice, config.defaultMaxPrice);

  const edge = conviction.fairProbability != null ? conviction.fairProbability - leg.price : null;

  // 1. Stake sanity + per-trade ceiling. Never silently trim — refuse and say so.
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

  // 3. Never chase: refuse if the outcome is already priced above the ceiling.
  if (leg.price > ceiling) {
    return {
      approved: false,
      reason: `${leg.outcome} is trading at ${leg.price.toFixed(3)}, above the ${ceiling.toFixed(3)} ceiling — the move is already priced in, no edge left to capture.`,
      edge,
    };
  }

  // 4. Edge gate (only when the caller supplied a fair-value estimate).
  if (edge != null && edge <= 0) {
    return {
      approved: false,
      reason: `Your fair value ${conviction.fairProbability!.toFixed(3)} is at or below the market price ${leg.price.toFixed(3)} — no positive edge, so the desk holds.`,
      edge,
    };
  }

  // 5. Order-type selection.
  //    - A price ceiling => resting limit at the ceiling (controls slippage, captures the edge).
  //    - No ceiling + small size => FOK market order (immediate fill).
  //    - No ceiling + larger size => refuse; a blind market order at size invites slippage.
  let order: Order;
  if (conviction.maxPrice != null) {
    order = { tokenId: leg.tokenId, outcome: leg.outcome, amountUsd, price: floorToCent(ceiling), orderType: "GTC" };
  } else if (amountUsd <= 10) {
    order = { tokenId: leg.tokenId, outcome: leg.outcome, amountUsd, orderType: "FOK" };
  } else {
    return {
      approved: false,
      reason: `No price ceiling given for a $${amountUsd.toFixed(2)} order — set maxPrice to place a limit; the desk will not fire a blind market order at that size.`,
      edge,
    };
  }

  const edgeNote = edge != null ? ` (edge ${(edge * 100).toFixed(1)} pts vs market ${leg.price.toFixed(3)})` : ` at market ${leg.price.toFixed(3)}`;
  const typeNote = order.price != null ? `limit ${order.price.toFixed(2)}` : "market (FOK)";
  return {
    approved: true,
    order,
    edge,
    rationale: `Buy ${leg.outcome} $${amountUsd.toFixed(2)} as ${typeNote}${edgeNote}.`,
  };
}
