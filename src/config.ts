/**
 * Runtime configuration + risk limits, read once from the environment.
 *
 * Every limit here is a *safety* limit, enforced fail-closed by the discipline
 * engine (see execute/discipline.ts). Nothing about a caller's request can widen
 * them — a conviction can only ever ask for less risk than these ceilings.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** "live" places real on-chain swaps on X Layer. Any other value = dry-run only. */
  executionMode: (process.env.EXECUTION_MODE ?? "paper").toLowerCase(),
  get live(): boolean {
    return this.executionMode === "live";
  },

  /** Hard risk ceilings (USD). An order above either is refused, never trimmed silently. */
  // Sized so the desk's book funds many real executions rather than a few large
  // ones: on X Layer a $0.25 swap quotes within 0.1% of a $5 swap, so a small cap
  // costs nothing in execution quality and buys far more on-chain evidence.
  maxStakePerTradeUsd: num("MAX_STAKE_PER_TRADE_USD", 1),
  maxStakePerDayUsd: num("MAX_STAKE_PER_DAY_USD", 5),

  /** Default and maximum swap slippage tolerance (percent). A request above the max is refused. */
  defaultSlippagePercent: num("DEFAULT_SLIPPAGE_PERCENT", 1),
  maxSlippagePercent: num("MAX_SLIPPAGE_PERCENT", 3),
} as const;
