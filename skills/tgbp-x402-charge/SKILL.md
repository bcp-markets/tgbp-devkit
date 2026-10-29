---
name: tgbp-x402-charge
description: Put an x402 price in pence of tGBP on an Express endpoint with the dev kit's tgbpPaymentMiddleware, on Base Sepolia. Use when the user asks to charge for an API, make a route paid, sell API calls to agents, or accept x402 payments in tGBP.
---

# Charge for an endpoint in tGBP over x402

`tgbpPaymentMiddleware` from `@bcptechnologies/tgbp-kit/x402/server` prices an Express route in
whole pence of tGBP. An unpaid request gets HTTP 402 with the tGBP offer. A paid one gets the
route's response once the payment settles on Base Sepolia. The x402.org facilitator settles each
payment and pays the gas, so the seller holds no key, and the buyer needs no ETH.

1. Install the packages in the user's project:

   ```sh
   npm install @bcptechnologies/tgbp-kit viem @x402/core @x402/evm @x402/extensions @x402/express express
   ```

2. Ask the user for the address that receives the payments (`payTo`) and the price in whole pence.
   Never make up an address, and never ask for a private key: the seller does not need one.
3. Add the middleware before the route it prices. Routes are keyed `'<METHOD> <path>'`:

   ```ts
   import express from 'express'
   import { tgbpPaymentMiddleware } from '@bcptechnologies/tgbp-kit/x402/server'

   const app = express()
   app.use(
     tgbpPaymentMiddleware({
       routes: {
         'GET /quote': { pence: 5, payTo: '0xYourAddress', description: 'A quote' },
       },
     }),
   )
   app.get('/quote', (req, res) => res.json({ quote: '…' }))
   app.listen(4021)
   ```

   `payTo` must be a valid EVM address, or the middleware throws when it starts.
   `maxTimeoutSeconds` (optional) is how long a signed payment stays valid: 300 by default, at
   most 600.

4. Check it. An unpaid request must answer 402 with the offer in the `PAYMENT-REQUIRED` header,
   a base64 JSON object:

   ```sh
   curl -si http://127.0.0.1:4021/quote | grep -i -e '^HTTP' -e '^payment-required'
   ```

   Its `accepts[0]` has `network: "eip155:84532"` (Base Sepolia), `asset` set to the tGBP token
   address, `amount` in base units (5p is `"50000000000000000"`, since tGBP has 18 decimals) and `payTo`.

## Make the route safe to pay for

- The route's response goes out only once the payment settles. While it is pending, the
  middleware answers `503` with `Retry-After`, and the buyer retries with the same payment.
- The route handler runs again on each retry, so make it safe to run more than once.
- A handler that answers 4xx or 5xx cancels the settlement, so the buyer is not charged.
- One payment buys one response. A settled payment sent again gets `402` with
  `payment_already_settled`.
- The middleware remembers payments in its own process. Run one instance, or send a buyer's
  retries to the instance that took the payment.

The kit's [example seller](https://github.com/bcp-markets/tgbp-devkit/tree/main/examples/x402-seller)
is a whole paid API on these lines. To pay a route like this from an agent, use the
`tgbp-x402-pay` skill.

## Mainnet

The middleware defaults to tGBP on Base Sepolia and the x402.org facilitator, which serves
testnets only. To charge in mainnet tGBP, pass a mainnet `token` from the kit's registry and a
`facilitator` that serves that chain. Without a facilitator, the middleware refuses a mainnet
token when it starts.
