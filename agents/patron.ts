/**
 * Patron - an autonomous demo of the loop Oddsmith exists to close:
 *
 *   research signal  ->  conviction  ->  Oddsmith executes  ->  real swap on X Layer
 *
 * OKX.AI already has agents that surface signals. This is the trader that acts on
 * one. The patron pulls a REAL market signal (short-term momentum from a public
 * feed), forms a conviction on an X Layer asset, and hands it to the Oddsmith desk
 * over x402 - exactly how a research ASP on the marketplace would compose with it.
 *
 *   ODDSMITH_URL=... BUYER_PRIVATE_KEY=... npm run patron
 *
 * The desk itself enforces discipline and risk caps; the patron only forms and
 * submits the conviction. A real swap happens only if the desk is in live mode
 * and the patron confirms.
 */
import "dotenv/config";
import { OddsmithClient, type Conviction } from "../src/sdk/index.js";

const ODDSMITH_URL = (process.env.ODDSMITH_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const ASSET = process.env.PATRON_ASSET ?? "OKB";
const SIGNAL_ID = process.env.PATRON_SIGNAL_ID ?? "okb"; // CoinGecko id for the momentum read
const STAKE = Number(process.env.PATRON_STAKE_USD ?? 1);
const CONFIRM = process.env.PATRON_CONFIRM === "true";

interface Signal {
  bullish: boolean;
  changePct: number;
  note: string;
}

/** Real external signal: 24h momentum from CoinGecko. */
async function fetchSignal(id: string): Promise<Signal> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`signal feed HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
  const changePct = data[id]?.usd_24h_change ?? 0;
  return { bullish: changePct >= 0, changePct, note: `${id} 24h momentum ${changePct.toFixed(2)}%` };
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(14)} ${value}`);
}

async function main(): Promise<void> {
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key) throw new Error("BUYER_PRIVATE_KEY required (the wallet that pays the x402 service fee).");

  const desk = new OddsmithClient({ privateKey: key, baseUrl: ODDSMITH_URL });

  console.log("\nOddsmith patron - research signal to executed swap\n");
  line("desk", ODDSMITH_URL);
  line("buyer", desk.address);
  line("asset", ASSET);

  console.log("\n[1] Pulling a real market signal...");
  const signal = await fetchSignal(SIGNAL_ID);
  line("signal", signal.note);

  if (!signal.bullish) {
    console.log("\n  Signal is not bullish - a buy conviction is not warranted. The trader stands down.\n");
    return;
  }

  const conviction: Conviction = {
    asset: ASSET,
    amountUsd: STAKE,
    slippagePercent: 1,
  };

  console.log("\n[2] Asking the desk what it would do (paid preview, no swap)...");
  const preview = await desk.resolve(conviction);
  console.log(JSON.stringify(preview, null, 2));

  if (!CONFIRM) {
    console.log("\n[3] PATRON_CONFIRM not set - stopping before a real swap. Set PATRON_CONFIRM=true to execute.\n");
    return;
  }

  console.log("\n[3] Executing the conviction (real swap if the desk is live)...");
  const result = await desk.execute({ ...conviction, confirm: true });
  console.log(JSON.stringify(result, null, 2));
  console.log("");
}

main().catch((e) => {
  console.error("patron failed:", (e as Error).message);
  process.exit(1);
});
