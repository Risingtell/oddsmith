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

// rpc.xlayer.tech caps eth_getLogs at 100 blocks; drpc allows 10k.
const scanClient = createPublicClient({ chain: xlayer, transport: http(process.env.VERIFY_RPC ?? "https://xlayer.drpc.org") });
const readClient = createPublicClient({ chain: xlayer, transport: http() });

const CHUNK = BigInt(process.env.VERIFY_CHUNK ?? 10_000);

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
  let start = fromBlock;
  let chunk = CHUNK;
  while (start <= latest) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
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
      start = end + 1n;
      chunk = CHUNK;
    } catch {
      if (chunk <= 100n) break;
      chunk = chunk / 2n < 100n ? 100n : chunk / 2n;
    }
  }
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

let cache: { at: number; fills: OnChainFill[] } | null = null;
const TTL_MS = 15_000;
const blockTime = new Map<string, number>();

/** Every real fill the desk has placed, newest last. Cached briefly - it is a paid route. */
export async function listDeskFills(desk: Address): Promise<OnChainFill[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.fills;
  const spends = await scanTransfers({ from: desk });
  const fills = spends.map((s) => ({ txHash: s.txHash, block: s.block, amountUsd: s.usd }));
  cache = { at: Date.now(), fills };
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
export async function deployedTodayUsd(desk: Address): Promise<number> {
  const fills = await listDeskFills(desk);
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
