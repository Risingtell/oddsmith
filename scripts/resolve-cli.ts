/**
 * Local read-only smoke test for the execution venue.
 *
 *   npm run resolve -- OKB 2
 *
 * Resolves the asset on X Layer, pulls a live OKX DEX aggregator quote, and runs
 * the desk's discipline engine over it - the exact path behind /api/resolve and
 * the free demo widget. Moves no funds and needs no execution key, so it is the
 * cheapest way to confirm the venue is wired correctly before deploying.
 */
import "dotenv/config";
import { previewExecution } from "../src/execute/run.js";

const [asset = "OKB", amount = "2", maxPrice, fairValue] = process.argv.slice(2);

const report = await previewExecution({
  asset,
  amountUsd: Number(amount),
  maxPrice: maxPrice ? Number(maxPrice) : undefined,
  fairValue: fairValue ? Number(fairValue) : undefined,
});

console.log(JSON.stringify(report, null, 2));
