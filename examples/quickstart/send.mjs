import { isTgbpKitError, parseAmount } from '@tgbp/kit'
import { transfer } from '@tgbp/kit/evm'
import { publicClient, token, walletClient } from './tgbp.mjs'

const [to, value = '1'] = process.argv.slice(2)
if (!to) {
  console.error('Usage: node --env-file=.env send.mjs <recipient address> [amount]')
  process.exit(1)
}

try {
  const { hash, receipt } = await transfer({
    publicClient,
    walletClient,
    chain: token,
    to,
    amount: parseAmount(value, token.decimals),
  })
  console.log(`Sent ${value} tGBP, confirmed in block ${receipt.blockNumber}`)
  console.log(`${token.explorerUrl}/tx/${hash}`)
} catch (error) {
  // The kit explains the failures it can predict, such as an empty balance.
  if (!isTgbpKitError(error)) throw error
  console.error(`${error.code}: ${error.message}`)
  process.exit(1)
}
