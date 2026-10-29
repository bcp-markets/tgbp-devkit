# Build with tGBP

> **For AI agents.** This page is also Markdown, at [/index.md](https://dev.tokenisedgbp.com/index.md), and [llms.txt](https://dev.tokenisedgbp.com/llms.txt) lists every page. To act on tGBP, install the `tgbp-mcp` MCP server and the agent skills from `@bcptechnologies/tgbp-kit`: the [README](https://github.com/bcp-markets/tgbp-devkit#agents-mcp-server-skills-and-spend-policy) has the config. Start on testnet: Base Sepolia, test tGBP from the faucet, and the API sandbox, the server's default. Act through the server and its spend policy, and never ask for the API key or the wallet key.

tGBP is Tokenised GBP, a British pound stablecoin. Each token is backed one to one by cash and cash equivalents. It runs on Ethereum, Base, Solana and other chains, with 18 decimals on EVM chains and 9 on Solana.

Start with the [quickstart](https://dev.tokenisedgbp.com/quickstart.md). It takes a clean machine to a confirmed test tGBP transfer on Base Sepolia in about 15 minutes.

## Developer kit

[`@bcptechnologies/tgbp-kit`](https://github.com/bcp-markets/tgbp-devkit) is an open-source TypeScript kit under the MIT licence.

| Module | What it does |
| --- | --- |
| `@bcptechnologies/tgbp-kit` | The token registry: every tGBP deployment, its address and decimals. Amount parsing and formatting. |
| `@bcptechnologies/tgbp-kit/evm` | Balances, transfers and incoming-transfer watchers on EVM chains, built on viem. |
| `@bcptechnologies/tgbp-kit/solana` | The same helpers on Solana, built on `@solana/kit`. |
| `@bcptechnologies/tgbp-kit/api` | A typed client for the tGBP API's mint, redeem, swap and balance endpoints. It sends idempotency keys and retries only what is safe to repeat. Needs the API key you get at onboarding. |
| `@bcptechnologies/tgbp-kit/agent`, `tgbp-mcp` | An MCP server and agent skills that let an LLM agent send, mint, redeem and swap tGBP and pay x402 URLs, inside a spend policy you write. |
| `@bcptechnologies/tgbp-kit/x402/server`, `/client` | Charge per HTTP request in tGBP, or pay such a request, with x402 on Base Sepolia. |

The [README](https://github.com/bcp-markets/tgbp-devkit#readme) documents every helper and error code.

## API reference

Business clients mint and redeem tGBP through the tGBP API. Its full reference is at [mint.tgbp.io/api-reference](https://mint.tgbp.io/api-reference), behind your tGBP account login.

`@bcptechnologies/tgbp-kit/api` wraps those endpoints. Staging keys work against the sandbox, which runs on testnets and simulates bank transfers. The [README](https://github.com/bcp-markets/tgbp-devkit#mint-redeem-and-swap-api) shows a mint, a redemption and a swap quote.

## Agents

`tgbp-mcp` is an MCP server that lets an LLM agent read balances and send, mint, redeem and swap tGBP, and pay x402 URLs in tGBP. Every tool runs behind a spend policy, a JSON file that refuses any action it does not allow: by chain, destination, per-transfer cap and daily cap. A large redemption waits for a human to approve it. One agent skill per action ships with the package.

The policy runs inside the server's process. Give the agent the MCP server, never the API key or the wallet key. Setup and every policy field are in the [README](https://github.com/bcp-markets/tgbp-devkit#agents-mcp-server-skills-and-spend-policy).

## x402 payments

[x402](https://x402.org) lets an HTTP API charge per request, so an agent can pay for a call without an account or an API key. `@bcptechnologies/tgbp-kit/x402/server` prices an Express route in pence of tGBP, and `@bcptechnologies/tgbp-kit/x402/client` pays it. Both run on Base Sepolia with test tGBP. The payer needs test tGBP but no ETH, because the facilitator pays the gas. The [test tGBP faucet](https://dev.tokenisedgbp.com/quickstart.md) sends 10 test tGBP a day.

The [README](https://github.com/bcp-markets/tgbp-devkit#x402-payments-base-sepolia) covers both sides. The [x402 demo](https://github.com/bcp-markets/tgbp-devkit/tree/main/examples/x402-demo) runs the whole flow: an agent pays 5p for an API call.

## Community

Ask questions in the [tGBP developers Telegram group](https://t.me/tgbpdevs). For test tGBP, use the [faucet](https://dev.tokenisedgbp.com/quickstart.md).

> **Admins never DM first.** No tGBP admin will message you before you message them, and none will ask for a private key, a seed phrase or a payment. Anyone who does is an impostor: block and report them.

## Describing tGBP

Writing about tGBP in your app or docs? Read [how to describe tGBP accurately](https://dev.tokenisedgbp.com/brand.md) first.
