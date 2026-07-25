# Oddsmith

**The execution desk for on-chain trading agents.** Your research agent has the conviction. Oddsmith pulls the trigger.

OKX.AI already has agents that surface mispriced assets and emerging alpha. What has been missing is execution: an agent that turns a conviction into a real position without a manual hop. Oddsmith is that layer, and it is native to X Layer. It takes an asset and a stake, reads the live OKX DEX quote, applies a disciplined trading rule, and swaps USDt0 into the conviction on X Layer, returning the fill with proof. Paid per execution in USDt0. Nothing ever leaves the OKX ecosystem.

| | |
|---|---|
| Live desk | https://oddsmith.onrender.com |
| Landing + free demo | https://oddsmith.onrender.com/site |
| OKX.AI Agent | listed as an A2MCP provider |
| Network | X Layer, eip155:196 |
| Execution venue | OKX DEX aggregator (v6), on X Layer |
| Settlement | USDt0 service fee + USDt0 swaps, OKB gas |
| Payment surface | x402 exact + upto, MPP charge (+split) + session |

## Why this is not a wrapper

Anyone can forward a swap to a DEX. An execution desk decides whether the trade is worth making, and refuses when it is not. Oddsmith's discipline layer:

- **Never chases.** It refuses to buy an asset already trading above your price ceiling. If the move is priced in, there is no edge left to capture.
- **Gates on edge.** When you pass your own fair value, it holds unless the live quote is below it.
- **Sizes under hard caps.** Per-trade and daily stake ceilings, and a maximum slippage, are enforced fail-closed. A conviction can ask for less risk, never more.

The caller states intent once and gets a disciplined, executed position back, not a suggestion.

## The composability story

Oddsmith is built to compose with the marketplace's existing signal agents. A research ASP produces a conviction; Oddsmith executes it. The included `patron` agent demonstrates the full loop: it pulls a real market signal, forms a conviction, and hands it to the desk over x402, exactly how a signal ASP would.

```
research signal  ->  conviction  ->  Oddsmith (resolve + discipline + swap)  ->  real position on X Layer
```

## Capability map

Every feature maps to a named OKX capability:

| Oddsmith feature | OKX capability used |
|---|---|
| Per-execution service fee | x402 `exact` scheme, USDt0 on X Layer |
| Metered, capped execution fee | x402 `upto` scheme (registered) |
| Standing execution mandate + 10% signal-partner split | MPP `charge` with multi-recipient split |
| Pay-per-execution channel | MPP `session` with off-chain vouchers |
| Quote + swap execution | OKX DEX aggregator API (v6) |
| Settlement asset and gas | USDt0 + OKB, native to X Layer |
| Marketplace listing and discovery | OKX.AI A2MCP registration |

## Service surface

| Route | Payment | What it does |
|---|---|---|
| `POST /api/execute` | x402 exact $0.05 | Resolve, apply discipline, place a real OKX DEX swap, return the fill |
| `POST /api/resolve` | x402 exact $0.01 | Resolve and show the live quote, edge, and recommended order (no swap) |
| `POST /api/positions` | x402 exact $0.01 | The desk's recent executions with prices and tx hashes |
| `POST /api/mandate` | MPP charge + split | Enroll a standing execution mandate |
| `POST /session/desk` | MPP session | Pay-per-execution channel |
| `POST /api/demo/resolve` | free, rate-limited | Live quote + desk decision, no wallet |
| `GET /`, `/healthz`, `/site` | free | Discovery card, health, landing page |

Request shape for `execute` and `resolve`:

```json
{ "asset": "OKB", "amountUsd": 5, "maxPrice": 1.2, "fairValue": 1.5, "slippagePercent": 1, "confirm": true }
```

`asset` is a token symbol or 0x address on X Layer. The desk swaps USDt0 into it.

## SDK

```ts
import { OddsmithClient } from "@oddsmith/sdk";

const desk = new OddsmithClient({ privateKey, baseUrl: "https://oddsmith.onrender.com" });
const fill = await desk.execute({ asset: "OKB", amountUsd: 2, maxPrice: 1.2, confirm: true });
```

## Verify on-chain

Everything settles on X Layer and proves itself, read from chain, not from the app's database:

```bash
npm run verify
```

This scans USDt0 fee transfers to the treasury and confirms every recorded swap transaction on X Layer.

## Run locally

```bash
npm install
cp .env.example .env   # fill in OKX API creds + wallets
npm run dev            # desk on :4000
npm run patron         # autonomous research -> execution demo
```

## Live execution setup

Read paths (`resolve`, the free demo) need only the OKX API creds. Live swaps additionally require the desk wallet (`EXECUTION_PRIVATE_KEY`) funded with USDt0 and a little OKB for gas on X Layer, and `EXECUTION_MODE=live`. Until then the desk runs in paper mode and returns dry-run previews.

## Honest limitations

- **Bounded desk book.** The live desk executes on its own wallet under hard per-trade and daily caps. Multi-tenant execution on a caller's own wallet is a natural next step.
- **Discipline, not alpha.** Oddsmith is the execution layer; the quality of a conviction is the caller's (or a signal ASP's) responsibility. The desk enforces discipline and refuses bad prices; it does not promise the trade wins.

## Tech stack

TypeScript, Express, `@okxweb3/x402-{core,evm,express}`, `@okxweb3/mpp`, viem. Execution via the OKX DEX aggregator API (v6). Deployed on Render.

## License

MIT
