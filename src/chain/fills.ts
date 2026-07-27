/**
 * The desk's fills, read from X Layer rather than from any local file.
 *
 * Every execution spends USDt0 out of the desk wallet, so the chain already holds
 * the complete, tamper-proof record. Reading it back from here means the answer
 * survives a restart, a redeploy, or an ephemeral host wiping its disk - and it
 * means a buyer and an outside auditor are looking at exactly the same source.
 */
import { createPublicClient, formatUnits, getAddress, http, parseAbiItem, type Address } from "viem";
import { USDT0, xlayer } from "./xlayer.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** First block that can contain Oddsmith activity - the desk wallet's creation. */
export const GENESIS_BLOCK = 66_199_800n;

// drpc.org's free tier now hard-rejects eth_getLogs outright ("upgrade to paid
// plan"), so rpc.xlayer.tech is the default - but it caps every call at 100
// blocks. This scan runs synchronously inside POST /api/execute (the daily
// stake ceiling must be read fresh before any real swap), so it has to finish
// in seconds, not minutes: CONCURRENCY runs many 100-block calls in parallel
// rather than walking ~150k+ blocks one 100-block window at a time.
const scanClient = createPublicClient({ chain: xlayer, transport: http(process.env.VERIFY_RPC ?? "https://rpc.xlayer.tech") });
const readClient = createPublicClient({ chain: xlayer, transport: http() });

const CHUNK = BigInt(process.env.VERIFY_CHUNK ?? 100);
const CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY ?? 15);

export interface Transfer {
  txHash: string;
  from: string;
  to: string;
  usd: number;
  block: string;
}

/**
 * Chunked USDt0 Transfer scan, halving the range whenever the RPC refuses one.
 * Shared by the paid positions view and the standalone verifier so both report
 * from identical logic.
 */
export async function scanTransfers(
  args: { to: Address } | { from: Address },
  fromBlock = GENESIS_BLOCK,
  toBlock?: bigint,
): Promise<Transfer[]> {
  const latest = toBlock ?? (await readClient.getBlockNumber());
  const rows: Transfer[] = [];

  // Explicit work queue of 100-block windows, so CONCURRENCY workers can pull
  // from it at once instead of walking the range one window at a time.
  const ranges: Array<[bigint, bigint]> = [];
  for (let s = fromBlock; s <= latest; s += CHUNK) {
    const e = s + CHUNK - 1n > latest ? latest : s + CHUNK - 1n;
    ranges.push([s, e]);
  }

  let nextIdx = 0;
  const RETRIES = 5;

  async function worker(): Promise<void> {
    while (nextIdx < ranges.length) {
      const i = nextIdx++;
      const [start, end] = ranges[i];
      let lastErr: unknown;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          const logs = await scanClient.getLogs({ address: USDT0, event: TRANSFER, args, fromBlock: start, toBlock: end });
          for (const log of logs) {
            rows.push({
              txHash: log.transactionHash,
              from: getAddress(log.args.from!),
              to: getAddress(log.args.to!),
              usd: Number(formatUnits(log.args.value!, 6)),
              block: log.blockNumber.toString(),
            });
          }
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          // Sustained concurrent load hits this RPC's rate limit occasionally
          // even at a modest CONCURRENCY, so back off longer than a one-off
          // network blip would need before the final attempt gives up.
          if (attempt < RETRIES - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1) * (attempt + 1)));
        }
      }
      if (lastErr) {
        // Never return a short answer as if it were the whole history. A partial
        // scan silently under-reports revenue, hides fills a buyer paid to see,
        // and - worst - makes the daily stake ceiling fail OPEN by undercounting
        // what the desk already deployed. Callers must be able to tell the
        // difference between "nothing happened" and "we could not find out",
        // so a range that never comes back throws rather than being skipped.
        throw new Error(`chain scan incomplete at block ${start}: ${(lastErr as Error).message.split("\n")[0]}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker));
  rows.sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : BigInt(a.block) > BigInt(b.block) ? 1 : 0));
  return rows;
}

export interface OnChainFill {
  txHash: string;
  block: string;
  amountUsd: number;
  /** Filled in from the desk's own log when this host happens to have it. */
  asset?: string;
  price?: number;
  at?: string;
}

let cache: { at: number; desk: string; fills: OnChainFill[] } | null = null;
const TTL_MS = 15_000;
const blockTime = new Map<string, number>();

/** Drop the cached view - called right after a fill so the next read sees it. */
export function invalidateFills(): void {
  cache = null;
}

/**
 * Every real fill the desk has placed, newest last.
 *
 * Cached briefly because the positions route is paid and judges may hammer it.
 * `fresh` skips the cache: any read that a risk limit depends on must not be
 * allowed to see a stale total, or two executions inside the cache window both
 * pass a ceiling that only one of them should have.
 */
export async function listDeskFills(desk: Address, opts: { fresh?: boolean } = {}): Promise<OnChainFill[]> {
  if (!opts.fresh && cache && cache.desk === desk && Date.now() - cache.at < TTL_MS) return cache.fills;
  const spends = await scanTransfers({ from: desk });
  const fills = spends.map((s) => ({ txHash: s.txHash, block: s.block, amountUsd: s.usd }));
  cache = { at: Date.now(), desk, fills };
  return fills;
}

/**
 * Stake the desk has actually deployed today (UTC), derived from block timestamps.
 *
 * The daily ceiling has to be counted from the chain: a counter kept on disk quietly
 * resets whenever the host restarts, which would let the cap be exceeded without
 * anything appearing to go wrong. Throws rather than guessing low - the caller is
 * expected to refuse the trade if today's exposure cannot be established.
 */
export async function deployedTodayUsd(desk: Address, opts: { fresh?: boolean } = {}): Promise<number> {
  const fills = await listDeskFills(desk, opts);
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const fill of fills) {
    let ts = blockTime.get(fill.block);
    if (ts === undefined) {
      ts = Number((await readClient.getBlock({ blockNumber: BigInt(fill.block) })).timestamp);
      blockTime.set(fill.block, ts);
    }
    if (new Date(ts * 1000).toISOString().slice(0, 10) === today) total += fill.amountUsd;
  }
  return total;
}
