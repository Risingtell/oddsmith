/**
 * @oddsmith/sdk - turn a conviction into a real on-chain position in one call,
 * executed on the OKX DEX aggregator and paid per execution in USDt0 on X Layer.
 */
export { OddsmithClient } from "./client.js";
export type { OddsmithConfig, Conviction } from "./client.js";
export { X402Payer } from "./payer.js";
export type { CallOutcome } from "./payer.js";
