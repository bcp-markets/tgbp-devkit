/**
 * The Know Your Agent spend policy: a JSON file that says what an agent may do
 * with tGBP. Everything it does not allow is denied.
 *
 * Amounts are decimal pound strings ("250.00"). tGBP is worth one pound on
 * every chain, so one cap covers EVM and Solana alike.
 */
import { readFile } from 'node:fs/promises'

import { parseAmount } from '../amount.js'

export const SPEND_ACTIONS = ['balance', 'transfer', 'mint', 'redeem', 'swap', 'x402'] as const
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
   * addresses, redemption bank ids, and x402 payees. EVM addresses match
   * case-insensitively.
   */
  destinations: string[]
  /** The most one transfer, mint, redemption, swap or x402 payment may move, in pounds. */
  perTransferCap: string
  /** The most all of them together may move in one UTC day, in pounds. */
  dailyCap: string
  /** A redemption above this amount, in pounds, waits for a human to approve it. */
  redemptionApprovalAbove: string
  /** Which services x402 pays, from which budget, and how often. Required when `actions` has `x402`. */
  x402?: X402Rules
}

export interface X402Rules {
  /** The services an x402 payment may go to. A URL no service matches is refused. */
  services: X402Service[]
  /**
   * The most each category may spend in any rolling 24 hours, in pounds.
   * Every service's category needs a budget.
   */
  categoryBudgets: Record<string, string>
  /** The most x402 payments in any rolling minute. */
  paymentsPerMinute: number
}

export interface X402Service {
  /**
   * A host name, `api.example.com`, matches every https URL on that host's
   * default port. An endpoint, `https://api.example.com/v1/quotes`, matches
   * that origin and that path or any path below it. Where several match, an endpoint beats a
   * host and the longest path wins.
   */
  match: string
  /** The budget in `categoryBudgets` this service spends from. */
  category: string
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
const OPTIONAL_FIELDS = ['x402'] as const
const X402_FIELDS = ['services', 'categoryBudgets', 'paymentsPerMinute'] as const

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Validate a parsed policy file. Throws on any missing, unknown or malformed
 * field: a misspelt cap that was silently ignored would leave an agent
 * uncapped.
 */
export function parseSpendPolicy(input: unknown): SpendPolicy {
  if (!isRecord(input)) throw invalid('the policy must be a JSON object')
  const raw = input
  for (const key of Object.keys(raw)) {
    if (!([...FIELDS, ...OPTIONAL_FIELDS] as readonly string[]).includes(key)) {
      throw invalid(`unknown field "${key}"`)
    }
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
  if (raw.x402 !== undefined) policy.x402 = parseX402Rules(raw.x402)
  else if (policy.actions.includes('x402')) {
    throw invalid('a policy that allows "x402" needs "x402" rules')
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

/** The service `url` pays: the most specific match, or undefined when none matches. */
export function matchService(services: X402Service[], url: string): X402Service | undefined {
  const { hostname, origin, pathname, port, protocol } = new URL(url)
  let best: X402Service | undefined
  let bestRank = -1
  for (const service of services) {
    const match = parseMatch(service.match)
    // A host ranks 0; an endpoint ranks above every host, and a longer path above a shorter.
    const rank =
      'host' in match
        ? match.host === hostname && protocol === 'https:' && port === ''
          ? 0
          : -1
        : match.origin === origin && underPath(pathname, match.path)
          ? 1 + match.path.length
          : -1
    if (rank > bestRank) {
      best = service
      bestRank = rank
    }
  }
  return best
}

type ServiceMatch = { host: string } | { origin: string; path: string }

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

function parseMatch(match: string): ServiceMatch {
  if (!match.includes('://')) {
    if (!HOST.test(match)) throw invalid(`x402 service "${match}" is not a host name or a URL`)
    return { host: match.toLowerCase() }
  }
  let url: URL
  try {
    url = new URL(match)
  } catch {
    throw invalid(`x402 service "${match}" is not a valid URL`)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw invalid(
      `x402 service "${match}" must be an http(s) URL with no credentials, query or fragment`,
    )
  }
  return { origin: url.origin, path: url.pathname }
}

/** `/v1/quotes` covers `/v1/quotes` and `/v1/quotes/gbp`, never `/v1/quotesx`. */
function underPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

function parseX402Rules(value: unknown): X402Rules {
  if (!isRecord(value)) throw invalid('"x402" must be an object')
  for (const key of Object.keys(value)) {
    if (!(X402_FIELDS as readonly string[]).includes(key)) {
      throw invalid(`unknown field "x402.${key}"`)
    }
  }
  for (const key of X402_FIELDS) {
    if (value[key] === undefined) throw invalid(`missing field "x402.${key}"`)
  }
  const { services, categoryBudgets, paymentsPerMinute } = value
  if (!Array.isArray(services)) throw invalid('"x402.services" must be a list')
  const seen = new Set<string>()
  const parsed = services.map((service): X402Service => {
    if (
      !isRecord(service) ||
      Object.keys(service).some((key) => key !== 'match' && key !== 'category') ||
      typeof service.match !== 'string' ||
      typeof service.category !== 'string' ||
      service.category === ''
    ) {
      throw invalid('each "x402.services" entry must be { "match": "…", "category": "…" }')
    }
    // Compare parsed forms, so `API.example.com` and `api.example.com` are one service.
    const key = JSON.stringify(parseMatch(service.match))
    if (seen.has(key)) throw invalid(`x402 service "${service.match}" is listed twice`)
    seen.add(key)
    return { match: service.match, category: service.category }
  })
  if (!isRecord(categoryBudgets)) throw invalid('"x402.categoryBudgets" must be an object')
  // fromEntries defines own properties, so a category named "__proto__" stays data.
  const budgets = Object.fromEntries(
    Object.keys(categoryBudgets).map((category) => [
      category,
      amountField(categoryBudgets, category, `x402.categoryBudgets.${category}`),
    ]),
  )
  for (const { match, category } of parsed) {
    if (!Object.hasOwn(budgets, category)) {
      throw invalid(`x402 service "${match}" spends from "${category}", which has no budget`)
    }
  }
  if (
    typeof paymentsPerMinute !== 'number' ||
    !Number.isSafeInteger(paymentsPerMinute) ||
    paymentsPerMinute < 1
  ) {
    throw invalid('"x402.paymentsPerMinute" must be a whole number of at least 1')
  }
  return { services: parsed, categoryBudgets: budgets, paymentsPerMinute }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw invalid(`"${key}" must be a list of non-empty strings`)
  }
  return [...value]
}

function amountField(raw: Record<string, unknown>, key: string, name = key): string {
  const value = raw[key]
  if (typeof value !== 'string') throw invalid(`"${name}" must be a decimal string, e.g. "100.00"`)
  try {
    toPolicyUnits(value)
  } catch {
    throw invalid(`"${name}" must be a non-negative decimal string, e.g. "100.00"`)
  }
  return value
}

function invalid(reason: string): Error {
  return new Error(`Invalid spend policy: ${reason}`)
}
