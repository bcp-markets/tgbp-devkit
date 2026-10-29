# Release notes

> **For AI agents.** This page is also Markdown, at [/releases.md](https://dev.tokenisedgbp.com/releases.md), and [llms.txt](https://dev.tokenisedgbp.com/llms.txt) lists every page. To act on tGBP, install the `tgbp-mcp` MCP server and the agent skills from `@bcptechnologies/tgbp-kit`: the [README](https://github.com/bcp-markets/tgbp-devkit#agents-mcp-server-skills-and-spend-policy) has the config. Start on testnet: Base Sepolia, test tGBP from the faucet, and the API sandbox, the server's default. Act through the server and its spend policy, and never ask for the API key or the wallet key.

Each release of [`@bcptechnologies/tgbp-kit`](https://www.npmjs.com/package/@bcptechnologies/tgbp-kit) on npm and [`tgbp-kit`](https://pypi.org/project/tgbp-kit/) on PyPI, newest first. Dates are the day the release reached the registry.

## Not yet released

On the main branch, in the next npm release:

- A test tGBP faucet on Base Sepolia: the `tgbp-faucet` command and `@bcptechnologies/tgbp-kit/faucet`. It sends 10 test tGBP once a day per address.
- x402 payments run through the spend policy. The `x402` action, the caps and the daily spend ledger now cover them.

## tgbp-kit 0.1.0 for Python, 27 October 2026

- First release: a typed Python client for the tGBP mint, redeem and swap API. Install it with `pip install tgbp-kit`.

## @bcptechnologies/tgbp-kit 0.2.1, 26 October 2026

- The token registry lists test tGBP on Base Sepolia: `getEvmToken('base-sepolia')`.

## @bcptechnologies/tgbp-kit 0.1.2, 23 October 2026

- First release on npm: the token registry, balances, transfers and watchers on EVM chains and Solana, the typed client for the mint, redeem and swap API, the `tgbp-mcp` server and agent skills behind a client-side spend policy, and x402 helpers for Base Sepolia.
