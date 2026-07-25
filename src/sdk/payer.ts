/**
 * X402Payer — the buyer half of the Oddsmith SDK.
 *
 * A calling agent pays Oddsmith a real USDt0 micropayment over x402 on X Layer to
 * have its conviction executed. This wraps the OKX
 * x402 client so Argus can pay any `exact`-scheme endpoint on X Layer.
 *
 * Wire (OKX x402 v2): request → 402 with `PAYMENT-REQUIRED`; sign the chosen
 * `accepts` entry; replay with `PAYMENT-SIGNATURE`; settlement comes back in
 * `PAYMENT-RESPONSE` (→ status / transaction / amount / payer).
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { registerExactEvmScheme } from "@okxweb3/x402-evm/exact/client";
import { UptoEvmScheme } from "@okxweb3/x402-evm/upto/client";

export interface Settlement {
  status?: string;
  transaction?: string;
  amount?: string;
  payer?: string;
}

export interface Quote {
  scheme?: string;
  network?: string;
  payTo?: string;
  /** atomic amount required (USD₮0 base units) */
  value?: string;
}

export interface CallOutcome {
  httpStatus: number;
  paid: boolean;
  latencyMs: number;
  rawBody: string;
  body: unknown;
  /** decoded from the 402's PAYMENT-REQUIRED, if any */
  quote: Quote | null;
  /** decoded from PAYMENT-RESPONSE, if the call was paid + settled */
  settlement: Settlement | null;
  /** the PAYMENT-SIGNATURE header(s) we sent — captured so a probe can replay them */
  paymentHeaders: Record<string, string> | null;
}

type PaymentRequired = ReturnType<x402HTTPClient["getPaymentRequiredResponse"]>;

/** A parsed, payable 402 challenge — pay against this exact object (never re-fetch) so the price a caller checked is guaranteed the price it pays. */
export interface Challenge {
  paymentRequired: PaymentRequired;
  quote: Quote | null;
}

export interface Preflight {
  res: Response;
  status: number;
  hasChallengeHeader: boolean;
  /** non-null only when status is 402 AND the challenge parsed cleanly */
  challenge: Challenge | null;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class X402Payer {
  private readonly http: x402HTTPClient;
  readonly address: string;

  constructor(privateKey: string, rpcUrl = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech") {
    const account = privateKeyToAccount(privateKey as Hex);
    this.address = account.address;
    const client = new x402Client();
    // Register both dialects the desk can be charged in: `exact` (every priced
    // route today - EIP-3009, gasless for the buyer) and `upto` (Permit2-metered),
    // so a client built on this SDK can also answer a metered 402 unchanged.
    registerExactEvmScheme(client, {
      signer: account,
      schemeOptions: { rpcUrl },
      networks: ["eip155:196"],
    });
    client.register("eip155:196", new UptoEvmScheme(account, { rpcUrl }));
    this.http = new x402HTTPClient(client);
  }

  /**
   * Read-only: fetch unpaid and parse the 402 challenge, without ever paying.
   * The single source of truth for "what does this endpoint cost right now" —
   * `pay()` spends against the exact `Challenge` this returns, never a fresh
   * one, so a price checked here can't drift from the price actually paid.
   */
  async preflight(url: string, init: RequestInit = {}): Promise<Preflight> {
    const res = await fetch(url, init);
    const hasChallengeHeader = !!res.headers.get("PAYMENT-REQUIRED") || !!res.headers.get("payment-required");
    if (res.status !== 402) return { res, status: res.status, hasChallengeHeader, challenge: null };
    try {
      const paymentRequired = this.http.getPaymentRequiredResponse((n) => res.headers.get(n));
      return { res, status: res.status, hasChallengeHeader, challenge: { paymentRequired, quote: firstAccept(paymentRequired) } };
    } catch {
      // 402'd but the challenge itself didn't parse — treat as no payable challenge,
      // not as "free": callers must not silently proceed to pay against this.
      return { res, status: res.status, hasChallengeHeader, challenge: null };
    }
  }

  /** Complete a payment against an already-fetched `Challenge` — no second unpaid round-trip. */
  async pay(url: string, init: RequestInit, challenge: Challenge): Promise<CallOutcome> {
    const started = Date.now();
    const payload = await this.http.createPaymentPayload(challenge.paymentRequired);
    const paymentHeaders = this.http.encodePaymentSignatureHeader(payload);
    const paid = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...paymentHeaders },
    });
    const text = await paid.text();
    const settlement = safeSettle(this.http, (n) => paid.headers.get(n));
    return {
      httpStatus: paid.status,
      paid: paid.status < 300,
      latencyMs: Date.now() - started,
      rawBody: text,
      body: parseBody(text),
      quote: challenge.quote,
      settlement,
      paymentHeaders,
    };
  }

  /** Full pay-and-call: fetch, and if challenged, sign + pay once. */
  async call(url: string, init: RequestInit = {}): Promise<CallOutcome> {
    const started = Date.now();
    const pre = await this.preflight(url, init);
    if (!pre.challenge) {
      const text = await pre.res.text();
      return {
        httpStatus: pre.status,
        paid: false,
        latencyMs: Date.now() - started,
        rawBody: text,
        body: parseBody(text),
        quote: null,
        settlement: null,
        paymentHeaders: null,
      };
    }
    const outcome = await this.pay(url, init, pre.challenge);
    return { ...outcome, latencyMs: Date.now() - started };
  }

  /** Single fetch with caller-supplied headers — used to replay a stale signature. */
  async raw(url: string, init: RequestInit, headers: Record<string, string>): Promise<CallOutcome> {
    const started = Date.now();
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...headers } });
    const text = await res.text();
    return {
      httpStatus: res.status,
      paid: res.status < 300,
      latencyMs: Date.now() - started,
      rawBody: text,
      body: parseBody(text),
      quote: null,
      settlement: safeSettle(this.http, (n) => res.headers.get(n)),
      paymentHeaders: headers,
    };
  }
}

function firstAccept(paymentRequired: unknown): Quote | null {
  const accepts = (paymentRequired as { accepts?: Array<Record<string, unknown>> })?.accepts;
  if (!accepts?.length) return null;
  const a = accepts[0];
  return {
    scheme: a.scheme as string | undefined,
    network: a.network as string | undefined,
    payTo: a.payTo as string | undefined,
    // OKX x402 v2 names the atomic price `amount`; keep `value` as a fallback
    // for any resource server that emits the older field name.
    value: (a.amount ?? a.value) as string | undefined,
  };
}

function safeSettle(http: x402HTTPClient, getHeader: (n: string) => string | null | undefined): Settlement | null {
  try {
    return http.getPaymentSettleResponse(getHeader) as unknown as Settlement;
  } catch {
    return null;
  }
}
