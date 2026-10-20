# tgbp-devkit

Developer kit for tGBP, the tokenised British pound. This repo publishes
[`@tgbp/kit`](https://www.npmjs.com/package/@tgbp/kit): the tGBP token registry, plus helpers to
read balances, send transfers and watch incoming transfers on EVM chains and Solana.

```sh
npm install @tgbp/kit viem                                  # EVM
npm install @tgbp/kit @solana/kit @solana-program/token    # Solana
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

## Errors

Failures the kit can explain throw a `TgbpKitError` with a `code`:

| Code | Meaning |
|---|---|
| `TOKEN_PAUSED` | The token contract is paused on this chain (EVM). |
| `ADDRESS_BANNED` | The sender or recipient is banned (EVM), or their token account is frozen (Solana). |
| `WRONG_CHAIN_ADDRESS` | The address is not valid on this chain, or the client is on a different chain. |
| `INSUFFICIENT_BALANCE` | The sender holds less tGBP than the amount. |
| `UNKNOWN_CHAIN` | tGBP is not deployed on the requested chain. |

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

`src/registry/tokens.generated.ts` is generated from the private `bcp-markets/tGBP` repo. The
sources are `scripts/onboard/chainRegistry.ts`, `scripts/onboard/mesh-targets.json`, the committed
`deployments/` artifacts, and `contracts/StableTokenV1OFT.sol`.

```sh
TGBP_SOURCE_DIR=../tGBP pnpm generate:registry          # rewrite the file
TGBP_SOURCE_DIR=../tGBP pnpm generate:registry --check  # exit 1 if it has drifted
```

CI's `registry-drift` job checks out those files with a read-only deploy key on every push and
daily. It fails when the generated file no longer matches.

## Security

Report vulnerabilities as described at <https://tokenisedgbp.com/.well-known/security.txt>.

## Licence

[MIT](LICENSE)
