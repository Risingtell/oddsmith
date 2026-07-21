/**
 * Runtime configuration + risk limits, read once from the environment.
 *
 * Every limit here is a *safety* limit, enforced fail-closed by the discipline
 * engine (see execute/discipline.ts). Nothing about a caller's request can widen
 * them — a conviction can only ever ask for less risk than these ceilings, never
 * more.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** "live" places real on-chain Polymarket orders. Any other value = dry-run only. */
  executionMode: (process.env.EXECUTION_MODE ?? "paper").toLowerCase(),
  get live(): boolean {
    return this.executionMode === "live";
  },

  /** CLI binaries Oddsmith shells out to (installed + logged in on the host). */
  onchainosBin: process.env.ONCHAINOS_BIN ?? "onchainos",
  polymarketBin: process.env.POLYMARKET_BIN ?? "polymarket-plugin",

  /** Reported through OKX's strategy-attribution rail on every fill. */
  strategyId: process.env.STRATEGY_ID ?? "oddsmith",

  /** Hard risk ceilings (USD). An order above either is refused, never trimmed silently. */
  maxStakePerTradeUsd: num("MAX_STAKE_PER_TRADE_USD", 5),
  maxStakePerDayUsd: num("MAX_STAKE_PER_DAY_USD", 25),

  /**
   * Never buy an outcome already priced above this (0-1). The core discipline:
   * an execution desk does not chase a market that has already moved to the
   * conviction — there's no edge left to capture and the downside is asymmetric.
   */
  defaultMaxPrice: num("DEFAULT_MAX_PRICE", 0.97),
} as const;
