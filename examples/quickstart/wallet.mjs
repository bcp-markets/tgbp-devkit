import { existsSync, writeFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Never overwrite a key: the wallet and its test tGBP would be lost with it.
if (existsSync('.env')) {
  throw new Error('.env already exists. Keep using that wallet, or move the file away first.')
}

const key = generatePrivateKey()
writeFileSync('.env', `PRIVATE_KEY=${key}\n`, { mode: 0o600 })
console.log(`Test wallet created. Address: ${privateKeyToAccount(key).address}`)
