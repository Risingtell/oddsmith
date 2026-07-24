/**
 * Two-chain on-chain verifier — Oddsmith proves its own numbers the same way it
 * would prove anyone's.
 *
 *   Layer 1 (X Layer):  every USDt0 service fee paid into the treasury (PAY_TO)
 *   Layer 2 (Polygon):  every real Polymarket fill the desk placed, by tx receipt
 *
 * No Oddsmith API and no trust in its database: the fee side is re-derived from
 * X Layer Transfer logs; the fill side confirms each execution-log tx directly on
 * Polygon. A judge runs `npm run verify` and checks both claims against chain.
 */
import "dotenv/config";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { publicClient, USDT0, xlayer } from "../src/chain/xlayer.js";
import { listExecutions } from "../src/store.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Fresh project: default to a wide recent lookback; pin VERIFY_FROM_BLOCK once
// the first fee lands so early history never drifts out of the window.
const LOOKBACK = BigInt(process.env.VERIFY_LOOKBACK_BLOCKS ?? 600_000);
const FROM_OVERRIDE = process.env.VERIFY_FROM_BLOCK ? BigInt(process.env.VERIFY_FROM_BLOCK) : null;
const CHUNK = BigInt(process.env.VERIFY_CHUNK ?? 10_000);

// rpc.xlayer.tech caps eth_getLogs at 100 blocks; drpc allows 10k.
const scanClient = createPublicClient({
  chain: xlayer,
  transport: http(process.env.VERIFY_RPC ?? "https://xlayer.drpc.org"),
});

const polygon = {
  id: 137,
  name: "Polygon",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: { default: { http: [process.env.POLYGON_RPC ?? "https://polygon-rpc.com"] } },
} as const;
const polygonClient = createPublicClient({ chain: polygon, transport: http() });

const payTo = process.env.PAY_TO;
if (!payTo || payTo.length !== 42) {
  console.error("PAY_TO missing from .env — nothing to verify.");
  process.exit(1);
}
const treasury = getAddress(payTo);
const partner = process.env.SPLIT_PARTNER ? getAddress(process.env.SPLIT_PARTNER) : null;
const buyer = process.env.BUYER_PRIVATE_KEY ? privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as Hex).address : null;

async function usdt0Balance(addr: `0x${string}`): Promise<string> {
  const bal = await publicClient.readContract({ address: USDT0, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
  return formatUnits(bal, 6);
}
async function gasBalance(addr: `0x${string}`): Promise<string> {
  return formatUnits(await publicClient.getBalance({ address: addr }), 18);
}

async function main(): Promise<void> {
  console.log("ODDSMITH — two-chain verification");
  console.log(`  service fee token: USDt0 ${USDT0} (X Layer eip155:196)`);
  console.log(`  execution venue:   Polymarket (Polygon chain 137)\n`);

  // ---- wallet roll call (X Layer) ----
  const wallets: Array<[string, `0x${string}` | null]> = [
    ["treasury (PAY_TO)", treasury],
    ["signal partner", partner],
    ["buyer", buyer],
  ];
  for (const [label, addr] of wallets) {
    if (!addr) continue;
    const [usd, gas] = await Promise.all([usdt0Balance(addr), gasBalance(addr)]);
    console.log(`  ${label.padEnd(18)} ${addr}  ${usd} USDt0  |  ${gas} OKB`);
  }

  // ---- Layer 1: re-derive service-fee revenue from X Layer Transfer logs ----
  const latest = await publicClient.getBlockNumber();
  const from = FROM_OVERRIDE ?? (latest > LOOKBACK ? latest - LOOKBACK : 0n);
  console.log(`\n  [X Layer] scanning USDt0 fees to treasury, blocks ${from}..${latest}`);

  const rows: Array<{ tx: string; from: string; usd: number; block: bigint }> = [];
  let start = from;
  let chunk = CHUNK;
  while (start <= latest) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
    try {
      const logs = await scanClient.getLogs({ address: USDT0, event: TRANSFER, args: { to: treasury }, fromBlock: start, toBlock: end });
      for (const log of logs) {
        rows.push({ tx: log.transactionHash, from: getAddress(log.args.from!), usd: Number(formatUnits(log.args.value!, 6)), block: log.blockNumber });
      }
      start = end + 1n;
      chunk = CHUNK;
    } catch (e) {
      if (chunk <= 100n) {
        console.error(`  RPC refused 100-block ranges near ${start}: ${(e as Error).message.split("\n")[0]}`);
        break;
      }
      chunk = chunk / 2n < 100n ? 100n : chunk / 2n;
    }
  }
  if (rows.length === 0) {
    console.log("  no service-fee settlements found yet in the scanned window.");
  } else {
    const total = rows.reduce((s, r) => s + r.usd, 0);
    const payers = new Set(rows.map((r) => r.from));
    console.log(`  ${rows.length} fee settlements  |  ${payers.size} distinct payers  |  $${total.toFixed(4)} USDt0`);
    for (const r of rows.slice(-20)) {
      console.log(`   block ${r.block}  $${r.usd.toFixed(4).padStart(8)}  from ${r.from.slice(0, 10)}…  tx ${r.tx}`);
    }
  }

  // ---- Layer 2: confirm each real Polymarket fill on Polygon ----
  const fills = listExecutions().filter((e) => e.mode === "live" && e.filled && e.fill?.txHashes?.length);
  console.log(`\n  [Polygon] confirming ${fills.length} live fills from the execution log`);
  let confirmed = 0;
  for (const f of fills) {
    for (const tx of f.fill!.txHashes) {
      try {
        const receipt = await polygonClient.getTransactionReceipt({ hash: tx as `0x${string}` });
        const ok = receipt.status === "success";
        if (ok) confirmed++;
        console.log(`   ${ok ? "OK " : "!! "} ${f.order?.outcome ?? "?"} $${(f.order?.amountUsd ?? 0).toFixed(2)}  block ${receipt.blockNumber}  tx ${tx}`);
      } catch {
        console.log(`   ?? ${f.order?.outcome ?? "?"} — tx not found on Polygon: ${tx}`);
      }
    }
  }
  if (fills.length === 0) console.log("  no live fills recorded yet (paper mode or none placed).");
  else console.log(`  ${confirmed} fill tx(s) confirmed on Polygon.`);

  console.log(`\n  X Layer fees: https://www.oklink.com/x-layer  ·  Polygon fills: https://polygonscan.com`);
}

main().catch((e) => {
  console.error("verify failed:", (e as Error).message);
  process.exit(1);
});
