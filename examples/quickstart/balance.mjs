import { formatAmount } from '@bcptechnologies/tgbp-kit'
import { getBalance } from '@bcptechnologies/tgbp-kit/evm'
import { formatEther } from 'viem'
import { account, publicClient } from './tgbp.mjs'

const { amount, decimals } = await getBalance({
  publicClient,
  chain: 'base-sepolia',
  owner: account.address,
})
const gas = await publicClient.getBalance({ address: account.address })

console.log(`${account.address} holds ${formatAmount(amount, decimals)} tGBP`)
console.log(`and ${formatEther(gas)} Base Sepolia ETH for gas`)
