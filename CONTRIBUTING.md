# Contributing

Oddsmith is a live OKX Agent Payments Protocol execution desk (x402 + MPP)
placing real swaps on the OKX DEX aggregator on X Layer. Issues and pull
requests are welcome.

## Reporting a bug

Open an issue with:
- What you ran (`npm run patron`, `npm run resolve`, `npm run verify`, or a specific route call) and what you expected
- The actual output, including any error text
- Whether it reproduces against a fresh clone (`git clone`, `npm install`, no other setup)

## Making a change

1. Fork and clone the repo
2. `npm install`
3. `cp .env.example .env` and fill in credentials if your change touches a paid route
4. `npm run build` (typecheck) before opening a PR
5. If your change touches the execution/discipline path, test it in paper mode (`EXECUTION_MODE` unset or not `live`) before ever testing against `live` mode
6. Describe what changed and why in the PR description

## Security issues

Do not open a public issue for a security vulnerability — see [SECURITY.md](SECURITY.md).
