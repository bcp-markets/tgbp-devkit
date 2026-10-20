/**
 * Generates src/registry/tokens.generated.ts from a checkout of bcp-markets/tGBP.
 *
 *   TGBP_SOURCE_DIR=../tGBP pnpm generate:registry          # write the file
 *   TGBP_SOURCE_DIR=../tGBP pnpm generate:registry --check  # exit 1 on drift
 *
 * Sources, all read-only, as committed to git (CI checks out exactly these):
 *   - scripts/onboard/chainRegistry.ts    EVM chain ids, addresses, live/retired, anomalies
 *   - scripts/onboard/mesh-targets.json   Solana mints, keyed by the bcp-api chain id
 *   - deployments/                        artifacts, where committed, must match the above
 *   - contracts/StableTokenV1OFT.sol      proves decimals() is the ERC-20 default
 *
 * tGBP ignores deployments/ in git and commits only some artifacts (the EVM
 * testnets, Gnosis and Solana devnet have none), so an artifact is a
 * cross-check, never the only source.
 *
 * chainRegistry.ts imports LayerZero packages, so it is read with the
 * TypeScript parser and a small evaluator instead of being imported. Anything
 * the evaluator does not understand throws: a silent misread would publish a
 * wrong token address.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { getAddress } from 'viem'

import type {
  EvmTokenDeployment,
  SolanaTokenDeployment,
  TokenDeployment,
} from '../src/registry/types.js'

export const GENERATED_PATH = fileURLToPath(
  new URL('../src/registry/tokens.generated.ts', import.meta.url),
)

/** ERC-20 default; `assertNoDecimalsOverride` proves the contract keeps it. */
const EVM_DECIMALS = 18

/**
 * Solana clusters, by their id in mesh-targets.json, with the deployment
 * directory that may hold a matching OFT.json. The tGBP repo records neither
 * the cluster nor the decimals, so both come from `getAccountInfo` on each
 * mint, read on mainnet-beta and devnet on 2026-10-20: decimals are 9 on both,
 * and the `solana-testnet` artifacts' mint lives on devnet (it is absent on
 * the Solana testnet cluster).
 */
const SOLANA_CHAINS: Record<
  string,
  Pick<SolanaTokenDeployment, 'cluster' | 'network' | 'decimals'> & { deploymentDir: string }
> = {
  solana: {
    cluster: 'mainnet-beta',
    network: 'mainnet',
    decimals: 9,
    deploymentDir: 'solana-mainnet',
  },
  'solana-devnet': {
    cluster: 'devnet',
    network: 'testnet',
    decimals: 9,
    deploymentDir: 'solana-testnet',
  },
}

/** Deployment directories that are not public chains. */
const IGNORED_DEPLOYMENT_DIRS = new Set(['hardhat'])

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

interface MeshTargets {
  chains: { id: string; chainType: string; tokenMintAddress: string | null }[]
}

export function buildRegistry(sourceDir: string): TokenDeployment[] {
  const chains = evaluateExport(join(sourceDir, 'scripts/onboard/chainRegistry.ts'), 'CHAINS')
  if (!isRecord(chains)) throw new Error('chainRegistry.ts: CHAINS is not an object')
  assertNoDecimalsOverride(join(sourceDir, 'contracts/StableTokenV1OFT.sol'))
  const deploymentsDir = join(sourceDir, 'deployments')

  const evm: EvmTokenDeployment[] = []
  for (const [key, raw] of Object.entries(chains)) {
    const entry = record(raw, key)
    if (optional(entry, 'localForkOf', 'string', key)) continue
    const oftAddress = optional(entry, 'oftAddress', 'string', key)
    if (!oftAddress) {
      console.warn(`${key}: skipped, no oftAddress`)
      continue
    }
    const retiredField = optional(entry, 'retired', 'object', key)
    const retired = retiredField === undefined ? undefined : record(retiredField, `${key}.retired`)
    // A known anomaly on a live chain is a contract tGBP did not deploy
    // (base-sepolia's orphan proxy); never publish it as the token, even when
    // an artifact is committed. Retired chains stay listed, marked, so holders
    // can still find theirs.
    if (entry.knownAnomaly !== undefined && !retired) {
      console.warn(`${key}: skipped, knownAnomaly on a live chain`)
      continue
    }
    const hardhatNetwork = required(entry, 'hardhatNetwork', 'string', key)
    const oftDeploymentName = required(entry, 'oftDeploymentName', 'string', key)
    const artifact = join(deploymentsDir, hardhatNetwork, `${oftDeploymentName}.json`)
    if (existsSync(artifact)) {
      const address = required(readJson(artifact), 'address', 'string', artifact)
      if (address.toLowerCase() !== oftAddress.toLowerCase()) {
        throw new Error(
          `${key}: chainRegistry oftAddress ${oftAddress} != deployment artifact ${address}`,
        )
      }
    }
    const blockExplorer = record(required(entry, 'blockExplorer', 'object', key), key)
    evm.push({
      chain: key,
      family: 'evm',
      network: required(entry, 'isMainnet', 'boolean', key) ? 'mainnet' : 'testnet',
      status: retired ? 'retired' : 'live',
      ...(retired ? { retiredOn: required(retired, 'date', 'string', `${key}.retired`) } : {}),
      symbol: 'tGBP',
      decimals: EVM_DECIMALS,
      chainId: required(entry, 'chainId', 'number', key),
      address: getAddress(oftAddress),
      explorerUrl: required(blockExplorer, 'browserUrl', 'string', `${key}.blockExplorer`),
    })
  }

  const mesh = readJson(join(sourceDir, 'scripts/onboard/mesh-targets.json')) as MeshTargets
  const meshSolana = mesh.chains.filter((c) => c.chainType === 'solana')
  for (const c of meshSolana) {
    if (!SOLANA_CHAINS[c.id]) {
      throw new Error(`mesh-targets.json lists Solana chain "${c.id}"; add it to SOLANA_CHAINS`)
    }
  }
  const solana: SolanaTokenDeployment[] = Object.entries(SOLANA_CHAINS).map(([chain, meta]) => {
    const { deploymentDir, ...rest } = meta
    const mint = meshSolana.find((c) => c.id === chain)?.tokenMintAddress
    if (!mint || !BASE58_ADDRESS.test(mint)) {
      throw new Error(`mesh-targets.json has no valid tokenMintAddress for "${chain}"`)
    }
    const artifact = join(deploymentsDir, deploymentDir, 'OFT.json')
    if (existsSync(artifact) && required(readJson(artifact), 'mint', 'string', artifact) !== mint) {
      throw new Error(
        `${chain}: mesh-targets mint ${mint} != deployments/${deploymentDir}/OFT.json`,
      )
    }
    return { chain, family: 'solana', ...rest, status: 'live', symbol: 'tGBP', address: mint }
  })

  // A deployment directory nobody above accounts for is a chain this
  // generator has never seen: fail so a person decides what it is.
  const known = new Set([
    ...IGNORED_DEPLOYMENT_DIRS,
    ...Object.entries(chains).map(([key, c]) =>
      required(record(c, key), 'hardhatNetwork', 'string', key),
    ),
    ...Object.values(SOLANA_CHAINS).map((c) => c.deploymentDir),
  ])
  for (const dir of readdirSync(deploymentsDir)) {
    if (!known.has(dir)) {
      throw new Error(
        `deployments/${dir} is not a chainRegistry or Solana deployment; update scripts/generate-registry.ts`,
      )
    }
  }

  return [...evm, ...solana]
}

export function renderRegistry(tokens: TokenDeployment[]): string {
  return [
    '// GENERATED by scripts/generate-registry.ts from bcp-markets/tGBP. Do not edit.',
    '// Regenerate: TGBP_SOURCE_DIR=<path to tGBP checkout> pnpm generate:registry',
    "import type { TokenDeployment } from './types.js'",
    '',
    `export const TOKENS = ${JSON.stringify(tokens, null, 2)} as const satisfies readonly TokenDeployment[]`,
    '',
  ].join('\n')
}

function readJson(path: string): unknown {
  const text = readFileSync(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path}: invalid JSON`, { cause: error })
  }
}

type FieldType = 'string' | 'number' | 'boolean' | 'object'
type FieldValue<T extends FieldType> = T extends 'string'
  ? string
  : T extends 'number'
    ? number
    : T extends 'boolean'
      ? boolean
      : object

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value) || OPAQUE in value) throw new Error(`${where}: expected an object`)
  return value
}

/**
 * Reads one field the generator relies on. An opaque import marker or a wrong
 * type throws, naming the chain: a guessed value would publish a wrong token.
 */
function optional<T extends FieldType>(
  obj: unknown,
  field: string,
  type: T,
  where: string,
): FieldValue<T> | undefined {
  const value = record(obj, where)[field]
  if (value === undefined) return undefined
  if (isRecord(value) && OPAQUE in value) {
    throw new Error(`${where}: ${field} is an imported value the generator cannot read`)
  }
  if (typeof value !== type || value === null) {
    throw new Error(`${where}: ${field} must be a ${type}, got ${JSON.stringify(value)}`)
  }
  return value as FieldValue<T>
}

function required<T extends FieldType>(
  obj: unknown,
  field: string,
  type: T,
  where: string,
): FieldValue<T> {
  const value = optional(obj, field, type, where)
  if (value === undefined) throw new Error(`${where}: ${field} is missing`)
  return value
}

function assertNoDecimalsOverride(contractPath: string): void {
  const source = readFileSync(contractPath, 'utf8')
  if (/function\s+decimals\s*\(/.test(source)) {
    throw new Error(`${contractPath} overrides decimals(); EVM_DECIMALS can no longer be assumed`)
  }
}

const OPAQUE = Symbol('opaque')
type Opaque = { [OPAQUE]: string }

/**
 * Evaluates one exported const of a TypeScript module without running it.
 * Handles the subset chainRegistry.ts uses: object and array literals,
 * spreads, string/number/boolean literals, `+` on strings, and references to
 * other top-level consts. Imported bindings and member access on them
 * (`EndpointId.BASE_V2_MAINNET`) evaluate to an opaque marker; any field the
 * generator reads must not be one.
 */
export function evaluateExport(path: string, name: string): unknown {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const decls = new Map<string, ts.Expression>()
  const imports = new Set<string>()

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const bindings = stmt.importClause?.namedBindings
      if (stmt.importClause?.name) imports.add(stmt.importClause.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) imports.add(el.name.text)
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        imports.add(bindings.name.text)
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) decls.set(d.name.text, d.initializer)
      }
    }
  }

  const cache = new Map<string, unknown>()
  const where = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
    return `${path}:${line + 1}`
  }

  const resolveName = (id: string, node: ts.Node): unknown => {
    if (id === 'undefined') return undefined
    if (cache.has(id)) return cache.get(id)
    if (imports.has(id)) return { [OPAQUE]: id } satisfies Opaque
    const init = decls.get(id)
    if (!init) throw new Error(`${where(node)}: cannot resolve identifier ${id}`)
    const value = evaluate(init)
    cache.set(id, value)
    return value
  }

  // `__proto__` as a key would set the prototype instead of a field.
  const ownKey = (key: string, node: ts.Node) => {
    if (key === '__proto__') throw new Error(`${where(node)}: __proto__ key is not supported`)
    return key
  }

  const evaluate = (node: ts.Expression): unknown => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isIdentifier(node)) return resolveName(node.text, node)
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return evaluate(node.expression)
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const v = evaluate(node.operand)
      if (typeof v !== 'number') throw new Error(`${where(node)}: unary minus on non-number`)
      return -v
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = evaluate(node.left)
      const r = evaluate(node.right)
      if (typeof l !== 'string' || typeof r !== 'string') {
        throw new Error(`${where(node)}: '+' is only supported on strings`)
      }
      return l + r
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = evaluate(node.expression)
      if (target && typeof target === 'object' && OPAQUE in target) {
        return { [OPAQUE]: `${(target as Opaque)[OPAQUE]}.${node.name.text}` } satisfies Opaque
      }
      throw new Error(`${where(node)}: property access on a non-imported value`)
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map((el) => {
        if (ts.isSpreadElement(el)) throw new Error(`${where(el)}: array spread is not supported`)
        return evaluate(el)
      })
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {}
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const v = evaluate(prop.expression)
          if (!v || typeof v !== 'object') throw new Error(`${where(prop)}: spread of non-object`)
          Object.assign(out, v)
        } else if (ts.isPropertyAssignment(prop)) {
          out[ownKey(propertyName(prop.name, where), prop)] = evaluate(prop.initializer)
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          out[ownKey(prop.name.text, prop)] = resolveName(prop.name.text, prop)
        } else {
          throw new Error(`${where(prop)}: unsupported object member`)
        }
      }
      return out
    }
    throw new Error(`${where(node)}: unsupported expression ${ts.SyntaxKind[node.kind]}`)
  }

  return resolveName(name, sf)
}

function propertyName(name: ts.PropertyName, where: (n: ts.Node) => string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  throw new Error(`${where(name)}: computed property names are not supported`)
}

function main(): void {
  const sourceDir = process.env.TGBP_SOURCE_DIR
  if (!sourceDir) {
    console.error('Set TGBP_SOURCE_DIR to a checkout of bcp-markets/tGBP')
    process.exit(2)
  }
  const rendered = renderRegistry(buildRegistry(resolve(sourceDir)))
  if (process.argv.includes('--check')) {
    const current = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf8') : ''
    if (current !== rendered) {
      console.error(`${GENERATED_PATH} has drifted from ${sourceDir}; run pnpm generate:registry`)
      process.exit(1)
    }
    console.log('Token registry matches the tGBP source.')
    return
  }
  writeFileSync(GENERATED_PATH, rendered)
  console.log(`Wrote ${GENERATED_PATH}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
