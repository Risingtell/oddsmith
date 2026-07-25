/**
 * On-chain verifier - Oddsmith proves its own numbers straight from X Layer.
 *
 *   Fees:  every USDt0 service fee paid into the treasury (PAY_TO)
 *   Swaps: every real execution the desk placed, confirmed by tx receipt
 *
 * Both live on X Layer, settled in USDt0 / OKB - nothing leaves the OKX
 * ecosystem, and nothing here is read from the app's own database. A judge runs
 * `npm run verify` and checks both against chain.
 */
import "dotenv/config";
import { erc20Abi, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { publicClient, USDT0 } from "../src/chain/xlayer.js";
import { listExecutions } from "../src/store.js";
// Deliberately the same scanner the paid positions route uses. If the verifier
// had its own copy, the two could drift and quietly disagree about what the desk
// has done - the one contradiction a trust product cannot afford.
import { scanTransfers, GENESIS_BLOCK } from "../src/chain/fills.js";

const FROM_OVERRIDE = process.env.VERIFY_FROM_BLOCK ? BigInt(process.env.VERIFY_FROM_BLOCK) : null;

const partner = process.env.SPLIT_PARTNER ? getAddress(process.env.SPLIT_PARTNER) : null;

/** The running desk, used to verify a deployment you do not hold the keys for. */
const DESK_URL = (process.env.ODDSMITH_URL ?? "https://oddsmith.onrender.com").replace(/\/+$/, "");

/**
 * The treasury, without needing a .env: a clean clone has no keys, so fall back
 * to the address the live desk names in its own unpaid 402 challenge. That makes
 * `git clone && npm install && npm run verify` enough to check every number here.
 */
async function resolveTreasury(): Promise<`0x${string}` | null> {
  const configured = process.env.PAY_TO;
  if (configured && configured.length === 42) return getAddress(configured);
  try {
    const res = await fetch(DESK_URL + "/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const challenge = (await res.json()) as { accepts?: Array<{ payTo?: string }> };
    const payTo = challenge.accepts?.[0]?.payTo;
    return payTo ? getAddress(payTo) : null;
  } catch {
    return null;
  }
}
const buyer = process.env.BUYER_PRIVATE_KEY ? privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as Hex).address : null;

/**
 * The desk wallet, without needing its key: a running desk publishes it on the
 * free discovery card, so anyone can verify a deployment they do not operate.
 */
async function resolveDesk(): Promise<`0x${string}` | null> {
  if (process.env.EXECUTION_PRIVATE_KEY) return privateKeyToAccount(process.env.EXECUTION_PRIVATE_KEY as Hex).address;
  try {
    const card = (await (await fetch(DESK_URL + "/")).json()) as { deskWallet?: string };
    return card.deskWallet ? getAddress(card.deskWallet) : null;
  } catch {
    return null;
  }
}


async function usdt0Balance(addr: `0x${string}`): Promise<string> {
  const bal = await publicClient.readContract({ address: USDT0, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
  return formatUnits(bal, 6);
}
async function gasBalance(addr: `0x${string}`): Promise<string> {
  return formatUnits(await publicClient.getBalance({ address: addr }), 18);
}

async function main(): Promise<void> {
  console.log("ODDSMITH - on-chain verification (X Layer, eip155:196)");
  console.log(`  service fee + execution token: USDt0 ${USDT0}`);
  console.log(`  venue: OKX DEX aggregator on X Layer\n`);

  const [treasury, desk] = await Promise.all([resolveTreasury(), resolveDesk()]);
  if (!treasury) {
    console.error(`  could not determine the treasury: set PAY_TO, or point ODDSMITH_URL at a running desk (tried ${DESK_URL}).`);
    process.exit(1);
  }

  const wallets: Array<[string, `0x${string}` | null]> = [
    ["treasury (PAY_TO)", treasury],
    ["signal partner", partner],
    ["desk wallet", desk],
    ["buyer", buyer],
  ];
  for (const [label, addr] of wallets) {
    if (!addr) continue;
    const [usd, gas] = await Promise.all([usdt0Balance(addr), gasBalance(addr)]);
    console.log(`  ${label.padEnd(18)} ${addr}  ${usd} USDt0  |  ${gas} OKB`);
  }

  // ---- fees: re-derive service-fee revenue from Transfer logs ----
  const latest = await publicClient.getBlockNumber();
  const from = FROM_OVERRIDE ?? GENESIS_BLOCK;
  console.log(`\n  [fees] scanning USDt0 transfers to treasury, blocks ${from}..${latest}`);
  const rows = await scanTransfers({ to: treasury }, from, latest);
  if (rows.length === 0) {
    console.log("  no service-fee settlements found yet in the scanned window.");
  } else {
    const total = rows.reduce((s, r) => s + r.usd, 0);
    const payers = new Set(rows.map((r) => r.from));
    console.log(`  ${rows.length} fee settlements  |  ${payers.size} distinct payers  |  $${total.toFixed(4)} USDt0`);
    for (const r of rows.slice(-20)) {
      console.log(`   block ${r.block}  $${r.usd.toFixed(4).padStart(8)}  from ${r.from.slice(0, 10)}...  tx ${r.txHash}`);
    }
  }

  // ---- swaps: re-derive the desk's real fills from the chain ----
  //
  // Deliberately NOT read from the app's own execution log. That log lives on the
  // host running the desk, so a judge cloning this repo would see zero fills while
  // the site claims real ones. Every fill spends USDt0 out of the desk wallet, so
  // the chain is both the honest source and the one anyone can reproduce.
  if (!desk) {
    console.log(`\n  [swaps] desk wallet unknown - set EXECUTION_PRIVATE_KEY, or ODDSMITH_URL to read it from a running desk.`);
  } else {
    console.log(`\n  [swaps] scanning USDt0 spent by the desk ${desk}, blocks ${from}..${latest}`);
    const spends = await scanTransfers({ from: desk }, from, latest);
    if (spends.length === 0) {
      console.log("  no live swaps found on-chain yet (paper mode, or none placed).");
    } else {
      let confirmed = 0;
      for (const s of spends) {
        const receipt = await publicClient.getTransactionReceipt({ hash: s.txHash as `0x${string}` });
        const ok = receipt.status === "success";
        if (ok) confirmed++;
        console.log(`   ${ok ? "OK " : "!! "} $${s.usd.toFixed(4).padStart(8)} deployed  block ${s.block}  tx ${s.txHash}`);
      }
      const total = spends.reduce((sum, s) => sum + s.usd, 0);
      console.log(`  ${confirmed}/${spends.length} swap tx(s) confirmed on X Layer  |  $${total.toFixed(4)} USDt0 deployed`);
    }

    // The local log adds asset/price detail when you are running the desk yourself.
    const local = listExecutions().filter((e) => e.mode === "live" && e.filled && e.fill?.txHash);
    if (local.length > 0) {
      console.log(`  local log detail (this host only):`);
      for (const f of local) {
        console.log(`   ${f.asset?.symbol ?? "?"} $${(f.order?.amountUsd ?? 0).toFixed(2)} at ${f.fill?.price?.toFixed(6)}  tx ${f.fill!.txHash}`);
      }
    }
  }

  console.log(`\n  verify any tx on OKLink: https://www.oklink.com/x-layer`);
}

main().catch((e) => {
  console.error("verify failed:", (e as Error).message);
  process.exit(1);
});
