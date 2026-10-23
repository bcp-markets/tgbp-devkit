import { formatAmount } from '@tgbp/kit'
import { getBalance } from '@tgbp/kit/evm'
import { formatEther } from 'viem'
import { account, publicClient, token } from './tgbp.mjs'

const { amount } = await getBalance({ publicClient, chain: token, owner: account.address })
const gas = await publicClient.getBalance({ address: account.address })

console.log(`${account.address} holds ${formatAmount(amount, token.decimals)} tGBP`)
console.log(`and ${formatEther(gas)} Base Sepolia ETH for gas`)
