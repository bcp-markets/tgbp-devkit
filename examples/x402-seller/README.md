# x402 seller example: charge 5p of tGBP per API call

`seller.ts` is a paid API on Base Sepolia. `GET /quote` costs 5p of test tGBP and `GET /health` is
free. It uses `tgbpPaymentMiddleware` from `@bcptechnologies/tgbp-kit/x402/server` and the
x402.org facilitator, which settles each payment and pays the gas. The seller holds no key.

## Run it

```sh
pnpm install
pnpm x402:seller --pay-to <address>              # listens on http://127.0.0.1:4021
pnpm x402:seller --pay-to <address> --port 8080
```

An unpaid `GET /quote` gets HTTP 402 with the tGBP payment terms in the `PAYMENT-REQUIRED` header.
Pay it with `createTgbpPaymentFetch` from `@bcptechnologies/tgbp-kit/x402/client`, or run the
[x402 demo](../x402-demo), whose agent pays this seller.

## What a buyer gets back

The quote goes out only after the payment settles on chain:

| Settlement | Answer |
|---|---|
| Confirmed | `200` with the quote, and the settlement in the `PAYMENT-RESPONSE` header. |
| Pending, or the facilitator gave no answer | `503` with `Retry-After: 2` and no quote. Retry with the same payment header. |
| Already settled for an earlier request | `402` with `payment_already_settled`. One payment buys one quote. |
| Failed | `402` with the facilitator's reason. |

A pending settlement never gets a 402: a 402 asks the buyer to pay, and a second payment while the
first is still settling would charge them twice. A retry of a pending payment skips verification,
because its Permit2 nonce may already be spent on chain. It asks the facilitator to settle that
same payment again, and the facilitator reports how the first submission ended. The `/quote`
handler runs on each retry; only the confirmed one sends the quote.

The seller remembers payments in its own process until ten minutes after their deadline. Behind a load
balancer, send a buyer's retries to the instance that took the payment.
