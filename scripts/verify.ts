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
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { USDT0, xlayer } from "../src/chain/xlayer.js";
import { listExecutions } from "../src/store.js";
// Deliberately the same scanner the paid positions route uses. If the verifier
// had its own copy, the two could drift and quietly disagree about what the desk
// has done - the one contradiction a trust product cannot afford.
import { scanTransfers, GENESIS_BLOCK } from "../src/chain/fills.js";

// The base client's default RPC (rpc.xlayer.tech) works from Render but
// CloudFront-blocks requests from at least one real cloud/datacenter IP range
// with a flat 403 - the exact class of environment an automated reviewer runs
// from. Every chain read in this script goes through xlayerrpc.okx.com
// instead (OKX's own endpoint), same as the scanner in chain/fills.ts, so the
// whole script is portable to whatever environment actually runs it.
const scanClient = createPublicClient({
  chain: xlayer,
  transport: http(process.env.VERIFY_RPC ?? "https://xlayerrpc.okx.com"),
});

const FROM_OVERRIDE = process.env.VERIFY_FROM_BLOCK ? BigInt(process.env.VERIFY_FROM_BLOCK) : null;

// A clean clone has no keys and .env.example's fields are placeholders, not
// real values — parsing them must fail closed to null, never throw, or a
// judge who copies .env.example verbatim gets a raw stack trace instead of a
// clear "nothing to verify." (Was previously a bare truthiness check here,
// which crashed on .env.example's literal "0x..." placeholders.)
function safeAddress(v: string | undefined): `0x${string}` | null {
  if (!v) return null;
  try {
    return getAddress(v);
  } catch {
    return null;
  }
}
function safeAccountAddress(pk: string | undefined): `0x${string}` | null {
  if (!pk) return null;
  try {
    return privateKeyToAccount(pk as Hex).address;
  } catch {
    return null;
  }
}

const partner = safeAddress(process.env.SPLIT_PARTNER);

/** The running desk, used to verify a deployment you do not hold the keys for. */
const DESK_URL = (process.env.ODDSMITH_URL ?? "https://oddsmith.onrender.com").replace(/\/+$/, "");

/**
 * The treasury, without needing a .env: a clean clone has no keys, so fall back
 * to the address the live desk names in its own unpaid 402 challenge. That makes
 * `git clone && npm install && npm run verify` enough to check every number here.
 */
async function resolveTreasury(): Promise<`0x${string}` | null> {
  const configured = safeAddress(process.env.PAY_TO);
  if (configured) return configured;
  try {
    const res = await fetch(DESK_URL + "/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const challenge = (await res.json()) as { accepts?: Array<{ payTo?: string }> };
    return safeAddress(challenge.accepts?.[0]?.payTo);
  } catch {
    return null;
  }
}
const buyer = safeAccountAddress(process.env.BUYER_PRIVATE_KEY);

/**
 * The desk wallet, without needing its key: a running desk publishes it on the
 * free discovery card, so anyone can verify a deployment they do not operate.
 */
async function resolveDesk(): Promise<`0x${string}` | null> {
  const fromKey = safeAccountAddress(process.env.EXECUTION_PRIVATE_KEY);
  if (fromKey) return fromKey;
  try {
    const card = (await (await fetch(DESK_URL + "/")).json()) as { deskWallet?: string };
    return safeAddress(card.deskWallet);
  } catch {
    return null;
  }
}


async function usdt0Balance(addr: `0x${string}`): Promise<string> {
  const bal = await scanClient.readContract({ address: USDT0, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
  return formatUnits(bal, 6);
}
async function gasBalance(addr: `0x${string}`): Promise<string> {
  return formatUnits(await scanClient.getBalance({ address: addr }), 18);
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
  const latest = await scanClient.getBlockNumber();
  const from = FROM_OVERRIDE ?? GENESIS_BLOCK;
  console.log(`\n  [fees] scanning USDt0 transfers to treasury, blocks ${from}..${latest}`);
  const allInflows = await scanTransfers({ to: treasury }, from, latest);

  // Not every USDt0 transfer into the treasury is an Oddsmith service fee. The same
  // address also receives sales from an unrelated storefront the owner runs, so
  // counting raw inflows would overstate this service's revenue. Those transfers are
  // listed explicitly below rather than silently dropped: the point of this script is
  // that anyone can reconcile it against the chain, which means the exclusions have to
  // be auditable too. Every tx here is a real payment, just not for this service.
  const NON_SERVICE_INFLOWS = new Map<string, string>([
    ["0xe1745c4b3ec4cc5c9e46d0c5b3edfc31202ec61b5141f31d11c36b35f6143a42", "storefront sale, not an Oddsmith fee"],
    ["0xdb111c221ba61de3033bd7db446d58a451a782ca226ed09b68ce21be7cbccb07", "storefront sale, not an Oddsmith fee"],
  ]);

  const excluded = allInflows.filter((r) => NON_SERVICE_INFLOWS.has(r.txHash.toLowerCase()));
  const rows = allInflows.filter((r) => !NON_SERVICE_INFLOWS.has(r.txHash.toLowerCase()));

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

  if (excluded.length > 0) {
    const excludedTotal = excluded.reduce((s, r) => s + r.usd, 0);
    console.log(`\n  [excluded] ${excluded.length} treasury inflows that are NOT Oddsmith service fees  |  $${excludedTotal.toFixed(4)} USDt0`);
    for (const r of excluded) {
      console.log(`   block ${r.block}  $${r.usd.toFixed(4).padStart(8)}  from ${r.from.slice(0, 10)}...  ${NON_SERVICE_INFLOWS.get(r.txHash.toLowerCase())}`);
    }
    console.log(`   (raw inflows to this address total $${allInflows.reduce((s, r) => s + r.usd, 0).toFixed(4)}; the difference is above)`);
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
        const receipt = await scanClient.getTransactionReceipt({ hash: s.txHash as `0x${string}` });
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
