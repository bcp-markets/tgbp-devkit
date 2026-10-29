# tGBP x402 facilitator

A Worker that runs the x402 reference facilitator (`@x402/core` and `@x402/evm` 2.28.0, pinned)
for tGBP on Base mainnet. It verifies and settles x402 payments in the `exact` and `upto`
schemes, with the `eip2612GasSponsoring` extension. The payer signs an EIP-2612 permit and a
Permit2 transfer, and the facilitator submits both in one transaction and pays its gas.

| Path | Who | What |
| --- | --- | --- |
| `GET /supported` | anyone | the schemes, extensions and gas key address |
| `POST /verify` | bearer token | checks a payment without moving anything |
| `POST /settle` | bearer token | submits the payment on chain |

## Rules

- **Gas-only key.** `FACILITATOR_PRIVATE_KEY` holds Base ETH for gas and never tGBP. The tGBP
  moves from the payer to the payee under the payer's own signatures, so the key never holds
  payer funds. It is separate from every `payTo` wallet.
- **Callers.** `/verify` and `/settle` need `Authorization: Bearer <FACILITATOR_AUTH_TOKEN>`, so
  no one else can spend the key's ETH. They take tGBP on `FACILITATOR_CHAIN` only. A payment in
  any other asset, network or scheme is refused before the facilitator reads the chain.
- **RPC.** `FACILITATOR_RPC_URL` is required, and the Worker refuses Base's public RPC on
  mainnet. It checks that the RPC reports the expected chain id before it builds the signer.
- **One instance.** A single Durable Object holds the signer and settles one payment at a time,
  so the key's nonces never race. It keeps x402's pending-settlement store in Durable Object
  storage. A settlement whose receipt timed out is found again by its tx hash after a restart,
  so a retry cannot broadcast it twice.
- **Low-gas alert.** Every 15 minutes a cron trigger reads the key's ETH balance. Below
  `MIN_GAS_ETH` (0.001 ETH) it posts `{"text": "…"}` to `ALERT_WEBHOOK_URL` and logs an error.
  It repeats at most every 6 hours while the balance stays low; a top-up re-arms it.
- **Known gap: no KYT screening.** The facilitator does not screen payers. tGBP's on-chain ban
  list still applies to every transfer.

A settlement used 154,419 gas on a Base mainnet fork. At 0.011 gwei that is about 0.0000017 ETH,
plus Base's L1 data fee.

## Go live

`go-live.sh` deploys the Worker and sets its secrets. On the first run it makes the gas key
inside a pipe straight into the Worker secret. It funds the key from a Foundry keystore and
settles a first 1p payment through the demo. The keystore account needs a little Base ETH and
at least 1p of tGBP.

```sh
BASE_RPC_URL=<private Base RPC URL> ALERT_WEBHOOK_URL=<webhook URL> \
  facilitator/go-live.sh <foundry keystore account>
```

It prints the bearer token once. Resource servers send it through `HTTPFacilitatorClient`'s
`createAuthHeaders`, as `examples/x402-demo/demo.ts` does.

## Test it locally

Put the secrets in `facilitator/.dev.vars` (gitignored). Then run the Worker against an anvil
fork of Base:

```sh
anvil --fork-url https://mainnet.base.org --port 8546
npx wrangler@4.119.0 dev --cwd facilitator --test-scheduled
BASE_RPC_URL=http://127.0.0.1:8546 X402_FACILITATOR_TOKEN=<token> \
  pnpm x402:demo --chain base --pence 1 --facilitator http://127.0.0.1:8787 --pay-to <address>
```

`curl 'http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*'` runs the gas check. Use a fresh
key for the fork: anvil's built-in keys carry sweeper delegations on Base mainnet. The unit
tests are in `test/facilitator.test.ts`.
