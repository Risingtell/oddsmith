# Security Policy

Oddsmith moves real money: it holds a funded desk wallet and places real
on-chain swaps on X Layer, settled via the OKX Agent Payments Protocol.
Treat anything that could misdirect funds, bypass a risk cap, or authorize
an unintended swap as a security issue, not a regular bug.

## Reporting a Vulnerability

Email **risingtell@gmail.com** with:
- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Whether it's already been exploited on the live deployment

Please do not open a public GitHub issue for a live vulnerability — the
desk is deployed and holds real funds at
[oddsmith.onrender.com](https://oddsmith.onrender.com).

We'll acknowledge reports promptly and credit responsible disclosure in the
README.

## Scope

In scope: the payment flows (x402 `exact`/`upto`, MPP `charge`/`session`),
the discipline/risk-cap logic (per-trade and daily ceilings, slippage,
never-chase), the swap execution path (approvals, gas, spender resolution),
and anything that could let a caller trigger a swap the discipline layer
should have refused, or exceed a stated risk ceiling.

Out of scope: the underlying `@okxweb3/*` SDKs, the OKX facilitator, and the
OKX DEX aggregator itself — report those to OKX directly.
