/**
 * The Know Your Agent spend policy: a JSON file that says what an agent may do
 * with tGBP. Everything it does not allow is denied.
 *
 * Amounts are decimal pound strings ("250.00"). tGBP is worth one pound on
 * every chain, so one cap covers EVM and Solana alike.
 */
import { readFile } from 'node:fs/promises'

import { parseAmount } from '../amount.js'

export const SPEND_ACTIONS = ['balance', 'transfer', 'mint', 'redeem', 'swap'] as const
export type SpendAction = (typeof SPEND_ACTIONS)[number]

/** Policy amounts are held at 18 decimals, so any chain's tGBP amount compares exactly. */
export const POLICY_DECIMALS = 18

export interface SpendPolicy {
  version: 1
  /** ISO 8601 time after which every action is denied. */
  expiresAt: string
  /** Actions the agent may take. */
  actions: SpendAction[]
  /** Registry chain keys the agent may act on, e.g. `sepolia`. */
  chains: string[]
  /**
   * Where value may go: transfer and swap recipients, mint destination
   * addresses, and redemption bank ids. EVM addresses match case-insensitively.
   */
  destinations: string[]
  /** The most one transfer, mint, redemption or swap may move, in pounds. */
  perTransferCap: string
  /** The most all of them together may move in one UTC day, in pounds. */
  dailyCap: string
  /** A redemption above this amount, in pounds, waits for a human to approve it. */
  redemptionApprovalAbove: string
}

const FIELDS = [
  'version',
  'expiresAt',
  'actions',
  'chains',
  'destinations',
  'perTransferCap',
  'dailyCap',
  'redemptionApprovalAbove',
] as const

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Validate a parsed policy file. Throws on any missing, unknown or malformed
 * field: a misspelt cap that was silently ignored would leave an agent
 * uncapped.
 */
export function parseSpendPolicy(input: unknown): SpendPolicy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('the policy must be a JSON object')
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw invalid(`unknown field "${key}"`)
  }
  for (const key of FIELDS) {
    if (raw[key] === undefined) throw invalid(`missing field "${key}"`)
  }
  if (raw.version !== 1) throw invalid('"version" must be 1')
  if (typeof raw.expiresAt !== 'string' || !ISO_TIME.test(raw.expiresAt)) {
    throw invalid('"expiresAt" must be an ISO 8601 time with a time zone')
  }
  if (Number.isNaN(Date.parse(raw.expiresAt))) throw invalid('"expiresAt" is not a real time')
  const actions = stringList(raw, 'actions')
  for (const action of actions) {
    if (!(SPEND_ACTIONS as readonly string[]).includes(action)) {
      throw invalid(`unknown action "${action}"; use ${SPEND_ACTIONS.join(', ')}`)
    }
  }
  const policy: SpendPolicy = {
    version: 1,
    expiresAt: raw.expiresAt,
    actions: actions as SpendAction[],
    chains: stringList(raw, 'chains'),
    destinations: stringList(raw, 'destinations'),
    perTransferCap: amountField(raw, 'perTransferCap'),
    dailyCap: amountField(raw, 'dailyCap'),
    redemptionApprovalAbove: amountField(raw, 'redemptionApprovalAbove'),
  }
  return policy
}

/** Read and validate a policy file. */
export async function loadSpendPolicy(path: string): Promise<SpendPolicy> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read the spend policy at ${path}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`The spend policy at ${path} is not valid JSON`, { cause: error })
  }
  return parseSpendPolicy(parsed)
}

/** Pounds as base units at `POLICY_DECIMALS`. */
export function toPolicyUnits(pounds: string): bigint {
  return parseAmount(pounds, POLICY_DECIMALS)
}

/** EVM addresses compare case-insensitively; bank ids and Solana addresses compare exactly. */
export function sameDestination(a: string, b: string): boolean {
  const evm = /^0x[0-9a-fA-F]{40}$/
  return evm.test(a) && evm.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b
}

function stringList(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw invalid(`"${key}" must be a list of non-empty strings`)
  }
  return [...value]
}

function amountField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string') throw invalid(`"${key}" must be a decimal string, e.g. "100.00"`)
  try {
    toPolicyUnits(value)
  } catch {
    throw invalid(`"${key}" must be a non-negative decimal string, e.g. "100.00"`)
  }
  return value
}

function invalid(reason: string): Error {
  return new Error(`Invalid spend policy: ${reason}`)
}
