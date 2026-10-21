# tgbp-devkit

Developer kit for tGBP, the tokenised British pound. This repo publishes
[`@tgbp/kit`](https://www.npmjs.com/package/@tgbp/kit): the tGBP token registry, helpers to
read balances, send transfers and watch incoming transfers on EVM chains and Solana, and a typed
client for the tGBP mint, redeem and swap API.

```sh
npm install @tgbp/kit viem                                  # EVM
npm install @tgbp/kit @solana/kit @solana-program/token    # Solana
npm install @tgbp/kit                                       # API client only
```

`viem`, `@solana/kit` and `@solana-program/token` are optional peer dependencies: install only the
chain library you use.

## Token registry

```ts
import { getToken, listTokens } from '@tgbp/kit'

getToken('base')
// { chain: 'base', family: 'evm', network: 'mainnet', status: 'live', symbol: 'tGBP',
//   decimals: 18, chainId: 8453, address: '0x27f6…5287', explorerUrl: 'https://basescan.org' }

listTokens({ network: 'testnet' })      // live testnet deployments
listTokens({ includeRetired: true })    // also chains that have left the mesh
```

tGBP has **18 decimals on EVM chains and 9 on Solana**. Every helper takes and returns base units
as `bigint`. Use `parseAmount('12.50', token.decimals)` and `formatAmount(amount, token.decimals)` at
the edge of your app. `parseAmount` throws rather than rounding away digits the token cannot hold.

Retired chains, such as Gnosis, have `status: 'retired'` and a `retiredOn` date. `listTokens()`
leaves them out unless you pass `includeRetired: true`.

The registry is generated from the tGBP contracts repo, so it never relies on a hand-maintained
copy. See [Regenerating the registry](#regenerating-the-registry).

## EVM

```ts
import { createPublicClient, createWalletClient, http } from 'viem'
import { base } from 'viem/chains'
import { parseAmount } from '@tgbp/kit'
import { getBalance, transfer, watchIncomingTransfers } from '@tgbp/kit/evm'

const publicClient = createPublicClient({ chain: base, transport: http() })
const walletClient = createWalletClient({ chain: base, transport: http(), account })

const { amount } = await getBalance({ publicClient, chain: 'base', owner: account.address })

const { hash } = await transfer({
  publicClient,
  walletClient,
  chain: 'base',
  to: '0x…',
  amount: parseAmount('25', 18),
})

const stop = watchIncomingTransfers({
  publicClient,
  chain: 'base',
  to: account.address,
  onTransfer: ({ from, amount, transactionHash }) => console.log(from, amount, transactionHash),
})
```

Before it signs, `transfer` reads the pause state, both parties' ban status and the sender's
balance. That way the common failures throw without spending gas.

## Solana

```ts
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit'
import { getBalance, transfer, watchIncomingTransfers } from '@tgbp/kit/solana'

const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com')
const rpcSubscriptions = createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com')

const { amount } = await getBalance({ rpc, chain: 'solana', owner: signer.address })

const { signature } = await transfer({
  rpc,
  rpcSubscriptions,
  signer,
  chain: 'solana',
  to: 'Recipient wallet address',
  amount: 25_000_000_000n, // 25 tGBP
})
```

`transfer` creates the recipient's associated token account when it does not exist yet, with the
sender paying the rent. It refuses a token account address as the recipient, because tokens sent
there could not be recovered. `prepareTransfer` builds and signs the same transaction without
sending it.

`watchIncomingTransfers` reports each increase in the owner's token account balance. Solana account
notifications do not carry the sender.

## Mint, redeem and swap API

`@tgbp/kit/api` calls the tGBP API with the API key you get at onboarding. It needs only `fetch`
(Node 20 or later, or a browser). Staging keys work against the sandbox, which runs on testnets
and simulates bank transfers.

```ts
import { createTgbpClient } from '@tgbp/kit/api'

const tgbp = createTgbpClient({ apiKey: process.env.TGBP_API_KEY, environment: 'sandbox' })

const mint = await tgbp.mints.create({
  customerId: 'customer_…',
  destinationAddress: '0x…',
  chain: 'sepolia',
  amount: { currency: 'GBP', value: 100 },
})
if (mint.status === 'created') {
  console.log(mint.data.bank_transfer_details) // pay this account, with this reference
  await tgbp.mints.simulatePayin(mint.data.id) // sandbox only
}

const redemption = await tgbp.redemptions.create({
  chain: 'sepolia',
  amount: { currency: 'GBP', value: 50 },
  bankId: 'bank_…',
})
// Then send the tGBP to redemption.data.burnAddress; GBP is paid out once the burn confirms.
```

`environment: 'production'` calls `https://api.tgbp.io`; `baseUrl` takes any other host. Each
method's argument and result types come from the API's OpenAPI spec.

The swap client converts between USDC and tGBP:

```ts
import { createTgbpSwapClient } from '@tgbp/kit/api'

const swap = createTgbpSwapClient({ apiKey: process.env.TGBP_API_KEY })
const { data: quote } = await swap.getQuote({ direction: 'USDC_TO_TGBP', usdcAmount: '100' })
const { data: balance } = await swap.getDepositBalance({ chainId: 'base' })
```

It defaults to production. For staging, pass the swap host from your onboarding pack as `baseUrl`.

### Idempotency and retries

Every call that creates a mint, redemption, swap intent or conversion sends an idempotency key.
The client generates one unless you pass `{ idempotencyKey }`, and returns it on the result.
A retry with the same key returns the first record and never creates a second one. Keys are 1 to
18 letters, digits, `_` or `-`, and last 24 hours.

The client retries a network error or a 5xx response up to 3 times, with backoff, and resends the
same key each time. It never retries a 4xx, including 429. It never retries a call that is unsafe
to repeat and has no key, such as `simulatePayin` or `cancelSwapIntent`. Set
`retry: { maxRetries, baseDelayMs }` to change this.

A create returns `status: 'created'` for a new record and `'replayed'` for an earlier one with
the same key. It returns `'pending_approval'` when your account needs a second person to approve
the action. Nothing exists until then, so do not retry.

Every request sends `User-Agent: tgbp-kit/<version>`. Browsers may drop that header.

## Errors

Failures the kit can explain throw a `TgbpKitError` with a `code`:

| Code | Meaning |
|---|---|
| `TOKEN_PAUSED` | The token contract is paused on this chain (EVM). |
| `ADDRESS_BANNED` | The sender or recipient is banned (EVM), or their token account is frozen (Solana). |
| `WRONG_CHAIN_ADDRESS` | The address is not valid on this chain, or the client is on a different chain. |
| `INSUFFICIENT_BALANCE` | The sender holds less tGBP than the amount. |
| `UNKNOWN_CHAIN` | tGBP is not deployed on the requested chain. |
| `API_ERROR` | The API answered with an error. `details` has `status`, `apiCode` and `requestId`. |
| `API_UNREACHABLE` | The API gave no response after every retry. |

After a 5xx or `API_UNREACHABLE`, a create may have taken effect. Retry it only with
`error.details.idempotencyKey`, or read the record before you send anything new.

A 409 on a create means an earlier request with this key is still in progress. Retry with the
same key, never a new one.

```ts
import { isTgbpKitError } from '@tgbp/kit'

try {
  await transfer(params)
} catch (error) {
  if (isTgbpKitError(error, 'INSUFFICIENT_BALANCE')) showTopUp(error.details)
  else throw error
}
```

The kit maps on-chain reverts (`EnforcedPause`, `AccountBanned`, `ERC20InsufficientBalance`) and
Solana token-program errors to the same codes.

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
```

The EVM tests start a local [anvil](https://getfoundry.sh) chain and run against `MockTgbp`, a test
double with tGBP's decimals, pause, ban list and custom errors. The Solana tests use an in-memory
RPC. `pnpm build:fixtures` recompiles the mock contract (it needs `forge`).

### Regenerating the registry

`src/registry/tokens.generated.ts` is generated from the private `the private tGBP contracts repo` repo. The
sources are `registry/chains.ts`, `registry/solana.json`, the committed
`deployments/` artifacts, and `contracts/StableTokenV1OFT.sol`.

```sh
TGBP_SOURCE_DIR=../tGBP pnpm generate:registry          # rewrite the file
TGBP_SOURCE_DIR=../tGBP pnpm generate:registry --check  # exit 1 if it has drifted
```

CI's `registry-drift` job checks out those files with a read-only deploy key on every push and
daily. It fails when the generated file no longer matches.

### Regenerating the API types

`src/api/core.generated.ts` and `src/api/swap.generated.ts` are generated from `openapi.yaml` and
`openapi-swap.yaml` in the private `the private API spec repo` repo. The generator keeps only the
mint, redeem, swap and balance operations, and drops the reference prose. `api-spec.lock` pins
the commit they come from.

```sh
TGBP_API_SPEC_DIR=../api-spec pnpm generate:api          # rewrite the files and the pin
TGBP_API_SPEC_DIR=../api-spec pnpm generate:api --check  # exit 1 if they have drifted
TGBP_API_SPEC_DIR=../api-spec pnpm check:disclosure      # scan the repo and dist/
```

CI's `api-drift` job checks out the pinned commit and fails on drift. It then runs the disclosure
sweep: no signing, custody or banking provider name may appear in this repo or in the published
build. The sweep reads its pattern from the api-spec vendor-name guard, so the names never
appear here.

### Sandbox test

`test/sandbox.integration.test.ts` mints test tGBP on the sandbox and then creates and cancels a
redemption. It runs when `TGBP_SANDBOX_API_KEY` is set, with `TGBP_SANDBOX_CUSTOMER_ID`,
`TGBP_SANDBOX_ADDRESS` and `TGBP_SANDBOX_BANK_ID` naming records that key's account owns.
CI's `sandbox` job runs it on `main` and daily, with all four set as secrets in the `sandbox`
environment.

## Security

Report vulnerabilities as described at <https://tokenisedgbp.com/.well-known/security.txt>.

## Licence

[MIT](LICENSE)
