# Judge Quickstart

Verify Oddsmith's claims in under five minutes. Nothing here needs a wallet.

## 1. It is live (10 seconds)

Open the landing page and try the free demo:

- https://oddsmith.onrender.com/site

Pick a coin and outcome, set a max price, and press Resolve. You get a real live Polymarket market, its current price, and the desk's decision: "Would execute" with a recommended order, or "Would hold" with the reason (for example, the outcome is already priced above your ceiling). This is the actual resolve-and-discipline path, run against a live market, with no payment.

Health and discovery:

- https://oddsmith.onrender.com/healthz  ->  `{ "ok": true, "paymentsReady": true, "executionMode": "..." }`
- https://oddsmith.onrender.com/  ->  full service card with pricing and risk limits

## 2. The discipline is real, not cosmetic (1 minute)

In the demo, set max price low (say 0.30) on a market currently trading higher. The desk returns "Would hold" and states that the move is already priced in. Raise the max price above the current price and it flips to "Would execute" with a resting limit order at your ceiling. That refusal logic is the core of the product: it is `src/execute/discipline.ts`.

## 3. The payment surface is compliant x402 (1 minute)

An unpaid call to a paid route returns a well-formed 402 with the challenge in both the header and the JSON body, advertising `eip155:196`:

```bash
curl -s -X POST https://oddsmith.onrender.com/api/resolve \
  -H 'content-type: application/json' -d '{"coin":"BTC","outcome":"up"}' | head
```

An unpaid GET on `/api/execute` answers the same 402, so OKX's `x402-check` validator passes.

## 4. It settles across two chains, verifiably (2 minutes)

```bash
git clone https://github.com/Risingtell/oddsmith && cd oddsmith
npm install
npm run verify
```

`npm run verify` reads USDt0 service-fee transfers to the treasury on X Layer, and confirms every recorded fill transaction directly on Polygon. Both numbers come from chain data, not the Oddsmith API.

## 5. The full loop, autonomous (1 minute)

```bash
npm run patron
```

The patron pulls a real market signal, forms a conviction, and submits it to the desk over x402: research to executed position, no human in the loop. This is the composability the marketplace is built for, one signal agent feeding one execution agent.

## What proves what

| Claim | Where to check |
|---|---|
| Live and reachable | `/site`, `/healthz` |
| Disciplined execution, not a wrapper | demo "Would hold" cases; `src/execute/discipline.ts` |
| Compliant x402 on X Layer | 402 response from `/api/resolve`, GET `/api/execute` |
| Two-chain settlement | `npm run verify` |
| Composable with signal agents | `npm run patron`, `agents/patron.ts` |
| Full OKX payment breadth | capability map in README |
