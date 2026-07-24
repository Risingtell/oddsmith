/**
 * OddsmithClient — the consumable SDK any agent can use to turn a conviction
 * into a real prediction-market position in one call.
 *
 *   const desk = new OddsmithClient({ privateKey, baseUrl });
 *   const fill = await desk.execute({ coin: "BTC", outcome: "up", amountUsd: 2, confirm: true });
 *
 * It handles the x402 payment handshake (USDt0 on X Layer) transparently — the
 * caller never touches the payment wire, just states the conviction and gets the
 * executed position back.
 */
import { X402Payer } from "./payer.js";

export interface OddsmithConfig {
  /** Buyer wallet private key (pays the x402 service fee in USDt0 on X Layer). */
  privateKey: string;
  /** Base URL of the Oddsmith desk, e.g. https://oddsmith.onrender.com */
  baseUrl: string;
  /** X Layer RPC (optional). */
  rpcUrl?: string;
}

/** A conviction to execute — the same shape the /api/execute route accepts. */
export interface Conviction {
  /** Outcome to buy: up / down / yes / no, or a categorical label. */
  outcome: string;
  amountUsd: number;
  /** One of these three selects the market (precedence: market > coin > thesis). */
  market?: string;
  coin?: string;
  window?: string;
  thesis?: string;
  /** Never pay above this price (0-1). */
  maxPrice?: number;
  /** Your own fair-value estimate (0-1) — drives the desk's edge check. */
  fairProbability?: number;
  /** Explicit go-ahead for a real on-chain fill (live mode). Omit for a preview. */
  confirm?: boolean;
}

export class OddsmithClient {
  private readonly payer: X402Payer;
  private readonly base: string;

  constructor(cfg: OddsmithConfig) {
    this.payer = new X402Payer(cfg.privateKey, cfg.rpcUrl);
    this.base = cfg.baseUrl.replace(/\/+$/, "");
  }

  /** The buyer wallet address paying for executions. */
  get address(): string {
    return this.payer.address;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const out = await this.payer.call(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (out.httpStatus >= 400) {
      const detail = typeof out.body === "object" && out.body ? JSON.stringify(out.body) : out.rawBody;
      throw new Error(`Oddsmith ${path} -> HTTP ${out.httpStatus}: ${detail}`);
    }
    return out.body as T;
  }

  /** Resolve + discipline + (if confirmed and the desk is live) a real fill. */
  execute<T = unknown>(conviction: Conviction): Promise<T> {
    return this.post<T>("/api/execute", conviction);
  }

  /** Resolve a conviction and see what the desk would do, without executing. */
  resolve<T = unknown>(conviction: Conviction): Promise<T> {
    return this.post<T>("/api/resolve", conviction);
  }

  /** Current open positions with live PnL. */
  positions<T = unknown>(address?: string): Promise<T> {
    return this.post<T>("/api/positions", address ? { address } : {});
  }
}
