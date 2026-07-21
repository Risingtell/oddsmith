/**
 * Typed wrapper around OKX's official `polymarket-plugin` binary.
 *
 * Oddsmith never constructs EIP-712 orders or signs by hand — the plugin owns
 * all signing and credential derivation (that's an explicit "do not" in its own
 * docs). We shell out to it, pass structured flags, and parse its JSON stdout.
 * Read commands (check-access, list-5m, get-market, list-markets) need no wallet;
 * `buy` / `get-positions` use the onchainos wallet the plugin is logged into.
 */
import { execFile } from "node:child_process";
import { config } from "../config.js";

export interface PluginError {
  code: string;
  message: string;
}

/** Run the plugin with args; resolve its parsed JSON stdout, or throw PluginError. */
function run<T = unknown>(args: string[], timeoutMs = 45_000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(config.polymarketBin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout ?? "").trim();
      // The plugin prints JSON on stdout even for many error states; prefer that.
      let parsed: unknown = null;
      if (out) {
        try {
          parsed = JSON.parse(out);
        } catch {
          /* non-JSON stdout — fall through to error handling */
        }
      }
      if (err && parsed == null) {
        const msg = (stderr ?? "").trim() || err.message;
        return reject({ code: "plugin_spawn_failed", message: msg } satisfies PluginError);
      }
      if (parsed == null) {
        return reject({ code: "plugin_no_json", message: `no JSON on stdout: ${out.slice(0, 300)}` } satisfies PluginError);
      }
      resolve(parsed as T);
    });
  });
}

export interface AccessResult {
  accessible: boolean | null; // null = indeterminate (network)
  country?: string;
  note?: string;
  warning?: string;
  indeterminate?: boolean;
}

/** Geoblock check — must pass before any live execution. */
export function checkAccess(): Promise<AccessResult> {
  return run<AccessResult>(["check-access"], 15_000);
}

export interface Market5m {
  slug: string;
  conditionId: string;
  question: string;
  timeWindow?: string;
  endDateUtc?: string;
  upPrice: number;
  downPrice: number;
  upTokenId: string;
  downTokenId: string;
  acceptingOrders: boolean;
}

/** Upcoming 5-minute Up/Down markets for a coin (BTC, ETH, SOL, XRP, BNB, DOGE, HYPE). */
export async function list5m(coin: string, count = 5): Promise<Market5m[]> {
  const res = await run<{ markets?: Market5m[] } | Market5m[]>(["list-5m", "--coin", coin, "--count", String(count)]);
  return Array.isArray(res) ? res : (res.markets ?? []);
}

export interface MarketToken {
  outcome: string;
  token_id: string;
  price: number;
  best_bid?: number;
  best_ask?: number;
  winner?: boolean;
}

export interface MarketDetail {
  condition_id: string;
  question: string;
  active?: boolean;
  closed?: boolean;
  accepting_orders?: boolean;
  end_date?: string;
  tokens: MarketToken[];
}

/** Full market detail + live order book, by slug or 0x condition_id. */
export function getMarket(marketId: string): Promise<MarketDetail> {
  return run<MarketDetail>(["get-market", "--market-id", marketId]);
}

export interface MarketSummary {
  question: string;
  condition_id: string;
  slug: string;
  end_date?: string;
  accepting_orders?: boolean;
  yes_price?: number;
  no_price?: number;
  yes_token_id?: string;
  no_token_id?: string;
  volume_24hr?: number;
  liquidity?: number;
}

/** Keyword search over active markets — used to resolve a natural-language thesis. */
export async function listMarkets(keyword: string, limit = 10): Promise<MarketSummary[]> {
  const res = await run<{ markets?: MarketSummary[] } | MarketSummary[]>(["list-markets", "--keyword", keyword, "--limit", String(limit)]);
  return Array.isArray(res) ? res : (res.markets ?? []);
}

export interface BuyParams {
  tokenId?: string;
  marketId?: string;
  outcome: string;
  amountUsd: number;
  price?: number; // limit price (0-1); omit for FOK market order
  orderType?: "GTC" | "FOK" | "GTD" | "FAK";
  dryRun: boolean;
}

export interface BuyResult {
  order_id?: string;
  status?: string; // live / matched / unmatched
  condition_id?: string;
  outcome?: string;
  token_id?: string;
  side?: string;
  order_type?: string;
  limit_price?: number;
  usdc_amount?: number;
  shares?: number;
  tx_hashes?: string[];
  // dry-run confirmation payloads vary; keep the raw object for the report
  [k: string]: unknown;
}

/** Place (or simulate) a real buy. `dryRun` never touches the chain. */
export function buy(p: BuyParams): Promise<BuyResult> {
  const args = ["buy", "--outcome", p.outcome, "--amount", String(p.amountUsd)];
  if (p.tokenId) args.push("--token-id", p.tokenId);
  if (p.marketId) args.push("--market-id", p.marketId);
  if (p.price != null) args.push("--price", String(p.price));
  if (p.orderType) args.push("--order-type", p.orderType);
  if (p.dryRun) args.push("--dry-run");
  if (config.strategyId) args.push("--strategy-id", config.strategyId);
  return run<BuyResult>(args, 90_000);
}

export interface Position {
  title: string;
  outcome: string;
  size: number;
  avg_price: number;
  cur_price: number;
  current_value: number;
  cash_pnl: number;
  percent_pnl: number;
  redeemable?: boolean;
  event_slug?: string;
  end_date?: string;
}

export async function getPositions(address?: string): Promise<Position[]> {
  const args = ["get-positions"];
  if (address) args.push("--address", address);
  const res = await run<{ positions?: Position[] } | Position[]>(args);
  return Array.isArray(res) ? res : (res.positions ?? []);
}
