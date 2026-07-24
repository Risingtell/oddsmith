/**
 * Patron — an autonomous demo of the loop Oddsmith exists to close:
 *
 *   research signal  ->  conviction  ->  Oddsmith executes  ->  real position
 *
 * OKX.AI already has agents that surface signals. This is the trader that acts on
 * one. The patron pulls a REAL market signal (BTC short-term momentum from a
 * public feed), forms a conviction, and hands it to the Oddsmith desk over x402 —
 * exactly how a research ASP on the marketplace would compose with Oddsmith.
 *
 *   ODDSMITH_URL=… BUYER_PRIVATE_KEY=… npm run patron
 *
 * The desk itself enforces discipline and risk caps; the patron only forms and
 * submits the conviction. A real fill happens only if the desk is in live mode
 * and the patron confirms.
 */
import "dotenv/config";
import { OddsmithClient, type Conviction } from "../src/sdk/index.js";

const ODDSMITH_URL = (process.env.ODDSMITH_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const COIN = (process.env.PATRON_COIN ?? "BTC").toUpperCase();
const STAKE = Number(process.env.PATRON_STAKE_USD ?? 2);
const CONFIRM = process.env.PATRON_CONFIRM === "true";

interface Signal {
  direction: "up" | "down";
  fairProbability: number;
  note: string;
}

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  BNB: "binancecoin",
  DOGE: "dogecoin",
};

/** Real external signal: 24h momentum from CoinGecko, mapped to a modest conviction. */
async function fetchSignal(coin: string): Promise<Signal> {
  const id = COINGECKO_IDS[coin];
  if (!id) throw new Error(`No signal source mapped for ${coin}.`);
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`signal feed HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
  const change = data[id]?.usd_24h_change ?? 0;
  const direction: "up" | "down" = change >= 0 ? "up" : "down";
  // Map momentum magnitude to a small confidence band around 50% — never overclaim edge.
  const strength = Math.min(Math.abs(change) / 10, 0.2); // cap at +/-20 pts
  const fairProbability = Number((0.5 + strength).toFixed(3));
  return {
    direction,
    fairProbability,
    note: `BTC-style 24h momentum ${change.toFixed(2)}% -> lean ${direction}, fair ${fairProbability}`,
  };
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(14)} ${value}`);
}

async function main(): Promise<void> {
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key) throw new Error("BUYER_PRIVATE_KEY required (the wallet that pays the x402 service fee).");

  const desk = new OddsmithClient({ privateKey: key, baseUrl: ODDSMITH_URL });

  console.log("\nOddsmith patron — research signal to executed position\n");
  line("desk", ODDSMITH_URL);
  line("buyer", desk.address);
  line("coin", COIN);

  console.log("\n[1] Pulling a real market signal...");
  const signal = await fetchSignal(COIN);
  line("signal", signal.note);

  const conviction: Conviction = {
    coin: COIN,
    window: "5m",
    outcome: signal.direction,
    amountUsd: STAKE,
    fairProbability: signal.fairProbability,
    maxPrice: 0.6, // discipline: only worth it if the market hasn't already priced the move in
  };

  console.log("\n[2] Asking the desk what it would do (paid preview, no fill)...");
  const preview = await desk.resolve(conviction);
  console.log(JSON.stringify(preview, null, 2));

  if (!CONFIRM) {
    console.log("\n[3] PATRON_CONFIRM not set — stopping before a real fill. Set PATRON_CONFIRM=true to execute.\n");
    return;
  }

  console.log("\n[3] Executing the conviction (real fill if the desk is live)...");
  const result = await desk.execute({ ...conviction, confirm: true });
  console.log(JSON.stringify(result, null, 2));
  console.log("");
}

main().catch((e) => {
  console.error("patron failed:", (e as Error).message);
  process.exit(1);
});
