# x402 demo: an agent pays 5p of tGBP for an API call

`demo.ts` runs a paid API and an agent that pays for it with test tGBP on Base Sepolia.

1. It makes a fresh payer key in memory and checks that the payer holds 0 ETH.
2. The payer receives 5p of test tGBP.
3. It starts the [example seller](../x402-seller) in the same process; it prices `GET /quote` at 5p
   with `tgbpPaymentMiddleware`.
4. The agent calls `/quote` with `createTgbpPaymentFetch`. It gets HTTP 402, and its spend
   guard allows the 5p and records it in the spend ledger. It signs an EIP-2612 permit for
   Permit2 and a Permit2 transfer, and sends the request again with the payment.
5. The x402.org facilitator settles the payment on Base Sepolia and pays the gas. The server
   returns the quote.
6. The script checks the settlement on chain: the payer paid exactly 5p, the payee received 5p,
   and the payer still holds 0 ETH. It checks that the 5p used up the run's daily cap, too. It
   exits 1 if any check fails.

## Run it

You need test tGBP on Base Sepolia. The faucet sends 10 test tGBP, once a day per address:

```sh
npx -p @bcptechnologies/tgbp-kit tgbp-faucet <address>
```

Fund your Foundry keystore account with it and pass `--fund-from`, or pass `--pay-to` and run the
faucet on the payer address the demo prints.

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

On 29 October 2026 a fresh payer holding 0 ETH paid 5p of test tGBP to the
[example seller](../x402-seller) for `/quote` and got the quote back. The seller sent the quote
only once the facilitator had settled the payment, in Base Sepolia block 51927547:
[`0x6fad6bf6…c1d25e0`](https://sepolia.basescan.org/tx/0x6fad6bf65c1a8539af55f4d459baffabfe6e69213eae0ca9fd3fbab67c1d25e0).

```text
PASS  payer holds 0 ETH
API response 200: {"quote":"GBP is the currency of the United Kingdom","paidWith":"5p of test tGBP"}
PASS  the paid request got the API response
PASS  the settlement transaction succeeded on Base Sepolia
PASS  the settlement moved exactly 5p of tGBP from the payer to 0xd63Cda198C9bc1D9B02Ab052D11bC66907236BBd
PASS  the payer paid 5p, once
PASS  the payer still holds 0 ETH: the facilitator paid the gas
PASS  the spend ledger counted the payment against the daily cap
```
