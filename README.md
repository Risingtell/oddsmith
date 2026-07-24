# Oddsmith

**The execution desk for prediction-market agents.** Your research agent has the conviction. Oddsmith pulls the trigger.

OKX.AI already has agents that surface mispriced odds and emerging alpha. What has been missing is execution: an agent that turns a conviction into a real position without a manual hop to the market. Oddsmith is that layer. It takes a thesis (or an explicit market and outcome), resolves it to a live Polymarket market, applies a disciplined trading rule, places a real on-chain fill, and returns the position with proof. Paid per execution in USDt0 on X Layer.

| | |
|---|---|
| Live desk | https://oddsmith.onrender.com |
| Landing + free demo | https://oddsmith.onrender.com/site |
| OKX.AI Agent | listed as an A2MCP provider |
| Network (service fee) | X Layer, eip155:196, settled in USDt0 |
| Execution venue | Polymarket (Polygon, chain 137), via OKX's official plugin |
| Payment surface | x402 exact + upto, MPP charge (+split) + session |

## Why this is not a wrapper

Anyone can forward an order to a market. An execution desk decides whether the trade is worth making, and refuses when it is not. Oddsmith's discipline layer:

- **Never chases.** It refuses to buy an outcome already trading above your price ceiling. If the move is priced in, there is no edge left to capture.
- **Gates on edge.** When you pass your own fair-value estimate, it holds unless the market price is below it.
- **Sizes under hard caps.** Per-trade and daily stake ceilings are enforced fail-closed. A conviction can ask for less risk, never more.
- **Picks the order type.** A price ceiling becomes a resting limit that captures the edge; a small unpriced order becomes a fill-or-kill; a large unpriced order is refused rather than sent into slippage.

The result is that the caller states intent once and gets a disciplined, executed position back, not a suggestion.

## The composability story

Oddsmith is built to compose with the marketplace's existing signal agents. A research ASP produces a conviction; Oddsmith executes it. The included `patron` agent demonstrates the full loop end to end: it pulls a real market signal, forms a conviction, and hands it to the desk over x402, exactly how a signal ASP would.

```
research signal  ->  conviction  ->  Oddsmith (resolve + discipline + fill)  ->  real position
```

## Capability map

Every feature maps to a named OKX capability, not inferred integration:

| Oddsmith feature | OKX capability used |
|---|---|
| Per-execution service fee | x402 `exact` scheme, USDt0 on X Layer |
| Metered, capped execution fee | x402 `upto` scheme (registered) |
| Standing execution mandate + 10% signal-partner split | MPP `charge` with multi-recipient split |
| Pay-per-execution channel | MPP `session` with off-chain vouchers |
| Market resolution and order placement | OKX official `polymarket-plugin` |
| Wallet, signing, settlement for fills | `onchainos` agentic wallet on Polygon |
| Fill attribution | `--strategy-id` reporting through OKX strategy attribution |
| Marketplace listing and discovery | OKX.AI A2MCP registration |

## Service surface

| Route | Payment | What it does |
|---|---|---|
| `POST /api/execute` | x402 exact $0.05 | Resolve, apply discipline, place a real fill, return the position |
| `POST /api/resolve` | x402 exact $0.01 | Resolve and show the odds, edge, and recommended order (no fill) |
| `POST /api/positions` | x402 exact $0.01 | Open positions with live PnL |
| `POST /api/mandate` | MPP charge + split | Enroll a standing execution mandate |
| `POST /session/desk` | MPP session | Pay-per-execution channel |
| `POST /api/demo/resolve` | free, rate-limited | Live market resolve + desk decision, no wallet |
| `GET /`, `/healthz`, `/site` | free | Discovery card, health, landing page |

Request shape for `execute` and `resolve`:

```json
{ "outcome": "up", "amountUsd": 2, "coin": "BTC", "maxPrice": 0.6, "fairProbability": 0.7, "confirm": true }
```

Select the market with one of: `coin` (+ `window`, 5-minute Up/Down), `market` (slug or 0x condition id), or `thesis` (natural language, keyword-resolved).

## SDK

Any agent can call the desk in one line, without touching the x402 wire:

```ts
import { OddsmithClient } from "@oddsmith/sdk";

const desk = new OddsmithClient({ privateKey, baseUrl: "https://oddsmith.onrender.com" });
const fill = await desk.execute({ coin: "BTC", outcome: "up", amountUsd: 2, maxPrice: 0.6, confirm: true });
```

## Verify on-chain

Oddsmith settles across two chains and proves both. Nothing here is read from the app's own database:

```bash
npm run verify
```

This scans USDt0 fee transfers to the treasury on X Layer, and confirms every recorded fill transaction directly on Polygon.

## Run locally

```bash
npm install
cp .env.example .env   # fill in OKX API creds + wallets
npm run dev            # desk on :4000
npm run patron         # autonomous research -> execution demo
```

## Live execution setup

Read paths (`resolve`, the free demo) need only the `polymarket-plugin` binary. Live fills additionally require `onchainos` logged into a funded Polygon (137) wallet:

```bash
onchainos wallet login your@email.com   # or API-key login on a server
polymarket-plugin check-access          # must be accessible (non-US/OFAC region)
polymarket-plugin balance               # needs USDC.e + a little POL
```

Then set `EXECUTION_MODE=live`. Until then the desk runs in paper mode and returns dry-run previews instead of placing orders.

## Honest limitations

- **Bounded desk book.** The live demo executes on Oddsmith's own wallet under hard per-trade and daily caps. Multi-tenant production executes on the caller's authorized wallet via OKX copy-trade (`--strategy-id` / `--autotrade-job`); the executor is a swappable module built for exactly that.
- **Region-gated.** Polymarket is unavailable in some jurisdictions. The desk runs `check-access` and refuses to fire from a restricted region rather than failing blind.
- **Venue.** Polymarket on Polygon today, via OKX's own plugin. When X Layer's Exchange OS exposes a programmatic outcome-market interface, it drops in as a second venue behind the same executor.

## Tech stack

TypeScript, Express, `@okxweb3/x402-{core,evm,express}`, `@okxweb3/mpp`, viem. Execution via the OKX `polymarket-plugin` and `onchainos` CLI. Deployed on Render (Frankfurt region).

## License

MIT
