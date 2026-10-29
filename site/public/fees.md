# Fees

> **For AI agents.** This page is also Markdown, at [/fees.md](https://dev.tokenisedgbp.com/fees.md), and [llms.txt](https://dev.tokenisedgbp.com/llms.txt) lists every page. To act on tGBP, install the `tgbp-mcp` MCP server and the agent skills from `@bcptechnologies/tgbp-kit`: the [README](https://github.com/bcp-markets/tgbp-devkit#agents-mcp-server-skills-and-spend-policy) has the config. Start on testnet: Base Sepolia, test tGBP from the faucet, and the API sandbox, the server's default. Act through the server and its spend policy, and never ask for the API key or the wallet key.

What you pay to build with tGBP, and who sets each fee.

## Free

- The kit, `@bcptechnologies/tgbp-kit` and `tgbp-kit` for Python, is open source under the MIT licence.
- Test tGBP on Base Sepolia has no value and costs nothing. The faucet sends 10 test tGBP a day to each address: see the [quickstart](https://dev.tokenisedgbp.com/quickstart.md).

## Network fees

Each on-chain transaction pays the network a fee, in the chain's own token. On EVM chains the sender's wallet pays gas, such as ETH on Base. On Solana the sender pays the transaction fee in SOL, plus rent for the recipient's token account if it has none yet. The fee goes to the network, and it depends on the chain and how busy it is.

## x402 payments

An x402 payment on Base Sepolia costs the payer the price the server asks and no gas. The payer signs the payment, and the x402.org facilitator settles it and pays the gas.

## Minting and redemption

Fees for minting and redeeming tGBP through the tGBP API depend on your account's terms. Each redemption the API returns carries `fees`: the fee's amount and its currency, GBP. An exchange or partner that sells tGBP sets its own fees.

For your account's terms, email support@tgbp.io.
