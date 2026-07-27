/**
 * OKX DEX executor — Oddsmith's execution venue, native to X Layer.
 *
 * A conviction is executed as a real swap on the OKX DEX aggregator (v6): the
 * desk's USDt0 is swapped into the conviction asset on X Layer (eip155:196),
 * settled in OKB gas. No external chain, no binary: signed OKX API + viem, the
 * exact pattern proven in Argus's swap-to-usdt0 script.
 *
 * Read paths (resolveToken, quote) never move funds. executeSwap approves the
 * router if needed, then sends the aggregator's calldata.
 */
import crypto from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xlayer, USDT0 } from "../chain/xlayer.js";
import { config } from "../config.js";

const BASE = process.env.OKX_BASE_URL ?? "https://web3.okx.com";
const CHAIN = "196"; // X Layer
const OKX_TIMEOUT_MS = Number(process.env.OKX_TIMEOUT_MS ?? 12_000);

/** HMAC-signed GET against the OKX DEX API (query string is part of the signature). */
async function signedGet<T = any>(path: string): Promise<T> {
  const ts = new Date().toISOString();
  const sign = crypto.createHmac("sha256", process.env.OKX_SECRET_KEY!).update(ts + "GET" + path).digest("base64");
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY!,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE!,
    "Content-Type": "application/json",
  };
  if (process.env.OKX_PROJECT_ID) headers["OK-ACCESS-PROJECT"] = process.env.OKX_PROJECT_ID;
  const res = await fetch(BASE + path, {
    headers,
    signal: AbortSignal.timeout(OKX_TIMEOUT_MS),
  });
  return (await res.json()) as T;
}

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

let tokenCache: TokenInfo[] | null = null;

/** Resolve a symbol or 0x address to a concrete X Layer token (address + decimals). */
export async function resolveToken(symbolOrAddress: string): Promise<TokenInfo> {
  const q = symbolOrAddress.trim();
  if (!tokenCache) {
    const res = await signedGet<{ code: string; data?: Array<{ tokenSymbol: string; tokenContractAddress: string; decimals: string }> }>(
      `/api/v6/dex/aggregator/all-tokens?chainIndex=${CHAIN}`,
    );
    if (res.code !== "0" || !res.data) throw new Error(`token list failed: ${JSON.stringify(res).slice(0, 200)}`);
    tokenCache = res.data.map((t) => ({ symbol: t.tokenSymbol, address: t.tokenContractAddress.toLowerCase(), decimals: Number(t.decimals) }));
  }
  if (q.startsWith("0x") && q.length === 42) {
    const hit = tokenCache.find((t) => t.address === q.toLowerCase());
    if (hit) return hit;
    return { symbol: q.slice(0, 8), address: q.toLowerCase(), decimals: 18 };
  }
  const hit = tokenCache.find((t) => t.symbol.toLowerCase() === q.toLowerCase());
  if (!hit) throw new Error(`asset "${q}" is not a swappable token on X Layer.`);
  return hit;
}

export interface Quote {
  fromAmountUsd: number;
  /** target-token units the desk would receive for fromAmountUsd of USDt0 */
  toAmount: number;
  /** price of one target token in USDt0 (fromAmountUsd / toAmount) */
  price: number;
  dexName?: string;
}

/** Read-only price for swapping `amountUsd` of USDt0 into `token`. Moves nothing. */
export async function quote(token: TokenInfo, amountUsd: number): Promise<Quote> {
  const amountAtomic = BigInt(Math.round(amountUsd * 1e6)).toString(); // USDt0 = 6 decimals
  const res = await signedGet<{ code: string; data?: any[] }>(
    `/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&chainId=${CHAIN}&amount=${amountAtomic}` +
      `&fromTokenAddress=${USDT0}&toTokenAddress=${token.address}`,
  );
  if (res.code !== "0" || !res.data?.length) throw new Error(`quote failed: ${JSON.stringify(res).slice(0, 200)}`);
  const d = res.data[0];
  const toAmount = Number(formatUnits(BigInt(d.toTokenAmount), token.decimals));
  if (!(toAmount > 0)) throw new Error("quote returned zero output.");
  return {
    fromAmountUsd: amountUsd,
    toAmount,
    price: amountUsd / toAmount,
    dexName: d.routerResult?.dexRouterList?.[0]?.dexProtocol?.[0]?.dexName,
  };
}

export interface SwapResult {
  txHash: string;
  status: "success" | "reverted";
  block: string;
  fromAmountUsd: number;
  toAmount: number;
  price: number;
}

/** Execute the swap: approve the router if needed, then send the aggregator calldata. */
export async function executeSwap(token: TokenInfo, amountUsd: number, slippagePercent: number): Promise<SwapResult> {
  const key = process.env.EXECUTION_PRIVATE_KEY;
  if (!key) throw new Error("EXECUTION_PRIVATE_KEY not configured — the desk wallet that holds USDt0 and signs swaps.");
  const account = privateKeyToAccount(key as Hex);
  const pub = createPublicClient({ chain: xlayer, transport: http() });
  const wallet = createWalletClient({ account, chain: xlayer, transport: http() });
  const amountAtomic = BigInt(Math.round(amountUsd * 1e6)).toString();

  // 1) Approve the OKX router to spend USDt0, if allowance is short.
  const appr = await signedGet<{ code: string; data?: any[] }>(
    `/api/v6/dex/aggregator/approve-transaction?chainIndex=${CHAIN}&chainId=${CHAIN}&tokenContractAddress=${USDT0}&approveAmount=${amountAtomic}`,
  );
  if (appr.code !== "0" || !appr.data?.length) throw new Error(`approve quote failed: ${JSON.stringify(appr).slice(0, 200)}`);
  const spender = appr.data[0].dexContractAddress as `0x${string}`;
  const allowance = (await pub.readContract({ address: USDT0, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] })) as bigint;
  if (allowance < BigInt(amountAtomic)) {
    const approveHash = await wallet.sendTransaction({ to: USDT0, data: appr.data[0].data as Hex });
    await pub.waitForTransactionReceipt({ hash: approveHash });
  }

  // 2) Fetch swap calldata and send it.
  const swap = await signedGet<{ code: string; data?: any[] }>(
    `/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&chainId=${CHAIN}&amount=${amountAtomic}` +
      `&fromTokenAddress=${USDT0}&toTokenAddress=${token.address}&userWalletAddress=${account.address}&slippagePercent=${slippagePercent}`,
  );
  if (swap.code !== "0" || !swap.data?.length) throw new Error(`swap quote failed: ${JSON.stringify(swap).slice(0, 200)}`);
  const tx = swap.data[0].tx;
  const toAmount = Number(formatUnits(BigInt(swap.data[0].routerResult?.toTokenAmount ?? "0"), token.decimals));
  const value = BigInt(tx.value ?? "0");

  // Do NOT trust the aggregator's suggested gas. Measured on X Layer it comes back
  // around 30% under what the swap actually needs (230,400 suggested against
  // 325,142 required), and an under-provisioned swap does not fail cheaply - it
  // burns the whole limit and reverts. Simulate first so a doomed swap costs
  // nothing at all, then send with headroom over a real estimate.
  let gasLimit: bigint;
  try {
    const estimated = await pub.estimateGas({ account, to: tx.to as `0x${string}`, data: tx.data as Hex, value });
    gasLimit = (estimated * 13n) / 10n;
  } catch (e) {
    throw new Error(`swap would revert on-chain, so it was not sent: ${(e as Error).message.split("\n")[0]}`);
  }
  const suggested = tx.gas ? BigInt(tx.gas) : 0n;
  if (suggested > gasLimit) gasLimit = suggested;

  const swapHash = await wallet.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data as Hex,
    value,
    gas: gasLimit,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: swapHash });
  return {
    txHash: swapHash,
    status: rcpt.status === "success" ? "success" : "reverted",
    block: rcpt.blockNumber.toString(),
    fromAmountUsd: amountUsd,
    toAmount,
    price: toAmount > 0 ? amountUsd / toAmount : 0,
  };
}

/** The desk wallet address that executes swaps (holds USDt0 on X Layer). */
export function deskAddress(): string | null {
  const key = process.env.EXECUTION_PRIVATE_KEY;
  return key ? privateKeyToAccount(key as Hex).address : null;
}

void config; // reserved for future per-venue config
