/**
 * Generates the API client's types from a checkout of the private API spec repo.
 *
 *   TGBP_API_SPEC_DIR=../api-spec pnpm generate:api          # write the files
 *   TGBP_API_SPEC_DIR=../api-spec pnpm generate:api --check  # exit 1 on drift
 *
 * The specs are private, and only the operations below are published. Each
 * spec is pruned to those operations and the components they reference, and
 * every prose field (description, summary, example) is dropped: the kit
 * discloses endpoint shapes, not the reference text. The output must also
 * pass the disclosure sweep before it is written.
 *
 * api-spec.lock pins the api-spec commit the types come from. CI checks
 * out exactly that commit and runs --check, so the types cannot drift from
 * the pin, and the pin moves only when someone regenerates.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'
import { parse } from 'yaml'

import { findDisclosures, loadVendorPattern } from './disclosure.js'

export const LOCK_PATH = fileURLToPath(new URL('../api-spec.lock', import.meta.url))

export const SPECS = [
  {
    source: 'openapi.yaml',
    output: fileURLToPath(new URL('../src/api/core.generated.ts', import.meta.url)),
    operations: [
      'createMint',
      'getMintById',
      'listMints',
      'cancelMint',
      'simulateMintPayin',
      'createRedemption',
      'getRedemption',
      'listRedemptions',
      'cancelRedemption',
      'quoteRedemption',
      'confirmRedemptionBurn',
    ],
  },
  {
    source: 'openapi-swap.yaml',
    output: fileURLToPath(new URL('../src/api/swap.generated.ts', import.meta.url)),
    operations: [
      'getQuote',
      'getLimits',
      'getSupportedNetworks',
      'getDepositSession',
      'createDepositAddress',
      'listDeposits',
      'getDepositBalance',
      'createSwapIntent',
      'getSwapIntent',
      'cancelSwapIntent',
      'createConversion',
    ],
  },
] as const

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']

/**
 * Reference prose, and server lists that would name hosts. Dropped everywhere
 * except as a property name inside `properties`.
 */
const PROSE_KEYS = new Set([
  'description',
  'summary',
  'title',
  'example',
  'examples',
  'externalDocs',
  'servers',
])

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keeps the named operations and every component they reach through `$ref`.
 * Throws when an operation is missing, so a rename upstream fails loudly.
 */
export function pruneSpec(spec: JsonObject, operationIds: readonly string[]): JsonObject {
  if (!isObject(spec.paths)) throw new Error('no paths')
  const wanted = new Set(operationIds)
  // A second operation with a wanted id would be dropped silently, typing the wrong endpoint.
  const seen = new Set<string>()
  const paths: JsonObject = {}
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!isObject(item)) continue
    const kept: JsonObject = {}
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method) || !isObject(operation)) continue
      const id = operation.operationId
      if (typeof id !== 'string' || !wanted.has(id)) continue
      if (seen.has(id)) throw new Error(`duplicate operationId ${id}`)
      seen.add(id)
      kept[method] = operation
    }
    if (Object.keys(kept).length === 0) continue
    if (item.parameters !== undefined) kept.parameters = item.parameters
    paths[path] = kept
  }
  const missing = [...wanted].filter((id) => !seen.has(id))
  if (missing.length > 0) {
    throw new Error(`operations not in the spec: ${missing.join(', ')}`)
  }

  const components = (spec.components ?? {}) as JsonObject
  const keptComponents: Record<string, JsonObject> = {}
  const pending: Json[] = [paths]
  while (pending.length > 0) {
    const node = pending.pop()
    if (Array.isArray(node)) {
      pending.push(...node)
    } else if (isObject(node)) {
      const ref = node.$ref
      if (typeof ref === 'string') {
        const [kind, name] = parseRef(ref)
        const target = (components[kind] as JsonObject | undefined)?.[name]
        if (target === undefined) throw new Error(`unresolved $ref ${ref}`)
        keptComponents[kind] ??= {}
        if (!(name in (keptComponents[kind] as JsonObject))) {
          ;(keptComponents[kind] as JsonObject)[name] = target
          pending.push(target)
        }
      }
      pending.push(...Object.values(node))
    }
  }
  // Only the shapes callers send and read; security schemes are set by the client.
  delete keptComponents.securitySchemes

  return stripProse({
    openapi: spec.openapi as string,
    info: { title: (spec.info as JsonObject).title as string, version: '' },
    paths: sortKeys(paths),
    components: sortKeys(
      Object.fromEntries(
        Object.entries(keptComponents).map(([kind, map]) => [kind, sortKeys(map)]),
      ),
    ),
  }) as JsonObject
}

function parseRef(ref: string): [string, string] {
  const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref)
  if (!match?.[1] || !match[2]) throw new Error(`unsupported $ref ${ref}`)
  return [match[1], match[2]]
}

function sortKeys(object: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function stripProse(node: Json, parentKey?: string): Json {
  if (Array.isArray(node)) return node.map((item) => stripProse(item))
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node)) {
    // Under `properties` the keys are field names; a field may be called `description`.
    if (parentKey !== 'properties' && (PROSE_KEYS.has(key) || key.startsWith('x-'))) continue
    out[key] = stripProse(value, key)
  }
  return out
}

export async function renderSpec(
  spec: JsonObject,
  source: string,
  operations: readonly string[],
): Promise<string> {
  const ast = await openapiTS(pruneSpec(spec, operations) as never, {
    alphabetize: true,
    defaultNonNullable: false,
  })
  return [
    `// Generated by scripts/generate-api.ts from the private API spec repo ${source}`,
    '// at the commit in api-spec.lock. Do not edit by hand.',
    '// Regenerate: TGBP_API_SPEC_DIR=<path to api-spec checkout> pnpm generate:api',
    '',
    astToString(ast),
  ].join('\n')
}

export function specCommit(apiDocsDir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: apiDocsDir, encoding: 'utf8' }).trim()
}

/** Renders every spec. Throws if any output would name a provider. */
export async function buildApiTypes(apiDocsDir: string): Promise<Map<string, string>> {
  const pattern = loadVendorPattern(apiDocsDir)
  const files = new Map<string, string>()
  for (const { source, output, operations } of SPECS) {
    const spec = parse(readFileSync(join(apiDocsDir, source), 'utf8')) as JsonObject
    const rendered = await renderSpec(spec, source, operations)
    const hits = findDisclosures(pattern, output, rendered)
    if (hits.length > 0) {
      const lines = hits.map((hit) => hit.line).join(', ')
      throw new Error(`${source}: generated types name a provider at lines ${lines}`)
    }
    files.set(output, rendered)
  }
  return files
}

async function main(): Promise<void> {
  const apiDocsDir = process.env.TGBP_API_SPEC_DIR
  if (!apiDocsDir) {
    console.error('Set TGBP_API_SPEC_DIR to a checkout of the private API spec repo')
    process.exit(2)
  }
  const dir = resolve(apiDocsDir)
  const check = process.argv.includes('--check')
  // api-spec.lock pins a commit, so types built from uncommitted edits would claim a source they lack.
  if (!check) {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    if (status.trim() !== '') {
      console.error(
        `${apiDocsDir} has uncommitted changes; commit or discard them, then regenerate`,
      )
      process.exit(1)
    }
  }
  const commit = specCommit(dir)
  const files = await buildApiTypes(dir)
  if (check) {
    const pinned = existsSync(LOCK_PATH) ? readFileSync(LOCK_PATH, 'utf8').trim() : ''
    let drifted = pinned !== commit
    if (drifted) console.error(`${apiDocsDir} is at ${commit}, but api-spec.lock pins ${pinned}`)
    for (const [path, rendered] of files) {
      if ((existsSync(path) ? readFileSync(path, 'utf8') : '') !== rendered) {
        console.error(`${path} has drifted from the pinned spec; run pnpm generate:api`)
        drifted = true
      }
    }
    if (drifted) process.exit(1)
    console.log('API types match the pinned spec.')
    return
  }
  for (const [path, rendered] of files) writeFileSync(path, rendered)
  writeFileSync(LOCK_PATH, `${commit}\n`)
  console.log(`Wrote the API types from api-spec ${commit}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
