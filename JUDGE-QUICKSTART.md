# Judge Quickstart

Verify Oddsmith's claims in under five minutes. Nothing here needs a wallet.

## 1. It is live (10 seconds)

Open the landing page and try the free demo:

- https://oddsmith.onrender.com/site

Type an asset (for example `OKB`), optionally set a max price, and press Resolve. You get a real live OKX DEX quote on X Layer and the desk's decision: "Would execute" with a recommended order, or "Would hold" with the reason (for example, the asset is already trading above your ceiling). This is the actual resolve-and-discipline path, run against a live quote, with no payment.

Health and discovery:

- https://oddsmith.onrender.com/healthz  ->  `{ "ok": true, "paymentsReady": true, "executionMode": "..." }`
- https://oddsmith.onrender.com/  ->  full service card with pricing, venue, and risk limits

## 2. The discipline is real, not cosmetic (1 minute)

In the demo, set max price below the live quote. The desk returns "Would hold" and states the move is already priced in. Raise it above the quote and it flips to "Would execute" with a sized order. That refusal logic is the core of the product: `src/execute/discipline.ts`.

## 3. The payment surface is compliant x402 on X Layer (1 minute)

An unpaid call to a paid route returns a well-formed 402 with the challenge in both header and JSON body, advertising `eip155:196`:

```bash
curl -s -X POST https://oddsmith.onrender.com/api/resolve \
  -H 'content-type: application/json' -d '{"asset":"OKB"}' | head
```

An unpaid GET on `/api/execute` answers the same 402, so OKX's `x402-check` validator passes.

## 4. It settles and proves itself on X Layer (2 minutes)

```bash
git clone https://github.com/Risingtell/oddsmith && cd oddsmith
npm install
npm run verify
```

`npm run verify` reads USDt0 service-fee transfers to the treasury and confirms every recorded swap transaction, straight from X Layer chain data. Not from the Oddsmith API.

## 5. The full loop, autonomous (1 minute)

```bash
npm run patron
```

The patron pulls a real market signal, forms a conviction, and submits it to the desk over x402: research to executed swap, no human in the loop. This is the composability the marketplace is built for, one signal agent feeding one execution agent.

## What proves what

| Claim | Where to check |
|---|---|
| Live and reachable | `/site`, `/healthz` |
| Disciplined execution, not a wrapper | demo "Would hold" cases; `src/execute/discipline.ts` |
| Compliant x402 on X Layer | 402 from `/api/resolve`, GET `/api/execute` |
| Native settlement, verifiable | `npm run verify` |
| Composable with signal agents | `npm run patron`, `agents/patron.ts` |
| Full OKX payment breadth | capability map in README |
