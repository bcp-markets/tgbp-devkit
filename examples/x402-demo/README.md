# x402 demo: an agent pays 5p of tGBP for an API call

`demo.ts` runs a paid API and an agent that pays for it with test tGBP on Base Sepolia.

1. It makes a fresh payer key in memory and checks that the payer holds 0 ETH.
2. The payer receives 5p of test tGBP.
3. A local Express server prices `GET /quote` at 5p with `tgbpPaymentMiddleware`.
4. The agent calls `/quote` with `createTgbpPaymentFetch`. It gets HTTP 402, signs an EIP-2612
   permit for Permit2 and a Permit2 transfer, and sends the request again with the payment.
5. The x402.org facilitator settles the payment on Base Sepolia and pays the gas. The server
   returns the quote.
6. The script checks the settlement on chain: the payer paid exactly 5p, the payee received 5p,
   and the payer still holds 0 ETH. It exits 1 if any check fails.

## Run it

You need test tGBP on Base Sepolia. Ask the tGBP developer program for some.

```sh
pnpm install
pnpm x402:demo --fund-from <foundry keystore account>   # cast sends the payer 5p from it
pnpm x402:demo --pay-to <address>                       # or fund the printed payer yourself
```

With `--fund-from`, the keystore needs a little Base Sepolia ETH for that one transfer, and the
payment goes back to the keystore's address. Set `BASE_SEPOLIA_RPC_URL` to use your own RPC
endpoint instead of `https://sepolia.base.org`.

## A recorded run

<!-- x402-demo-run -->
