/**
 * Disclosure sweep: fails when a signing, custody or banking provider name
 * appears in anything this public repo publishes.
 *
 *   TGBP_API_SPEC_DIR=<spec checkout> TGBP_VENDOR_GUARD=<guard path> \
 *     pnpm check:disclosure [--require-dist]
 *
 * The provider-name pattern is not copied here, because writing it down in a
 * public repo would itself disclose the names. It is read from the vendor-name
 * guard in the private API spec checkout, so this sweep and that one cannot
 * drift apart. TGBP_VENDOR_GUARD is the guard's path inside that checkout. A
 * hit is reported as file:line only: CI logs of a public repo are public too.
 * --require-dist fails when dist/ is missing, so CI cannot pass by sweeping no
 * build output.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Lockfile integrity hashes are base64 noise that a two-letter pattern can match. */
const INTEGRITY_TOKEN = /integrity: [A-Za-z0-9+/=-]+/

/**
 * A quote, a comma or plus, and a quote: the seam between two string literals
 * that code joins at runtime, as in ['Ac', 'me'].join('') or 'Ac' + 'me'.
 */
const LITERAL_SEAM = /(['"`])\s*[,+]\s*(['"`])/g

export interface Disclosure {
  file: string
  line: number
}

/** The guard's path inside the spec checkout, from TGBP_VENDOR_GUARD. Throws if it is unset. */
export function vendorGuardPath(apiSpecDir: string): string {
  const guard = process.env.TGBP_VENDOR_GUARD
  if (!guard) throw new Error('Set TGBP_VENDOR_GUARD to the vendor-name guard in the spec checkout')
  return join(apiSpecDir, guard)
}

/** Reads `VENDOR_PATTERN` from the vendor-name guard. Throws if it is not there. */
export function loadVendorPattern(guardPath: string): RegExp {
  // The guard's path is not public either, so no error below names it.
  let guard: string
  try {
    guard = readFileSync(guardPath, 'utf8')
  } catch {
    // Node's message would quote the path into a public CI log.
    throw new Error('vendor guard: cannot read the file TGBP_VENDOR_GUARD names')
  }
  const match = /const VENDOR_PATTERN\s*=\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*);/.exec(guard)
  if (!match?.[1]) {
    throw new Error('vendor guard: VENDOR_PATTERN not found; the guard has changed shape')
  }
  let pattern: RegExp
  try {
    // g and y make test() stateful, so drop them.
    pattern = new RegExp(match[1], (match[2] ?? '').replace(/[gy]/g, ''))
  } catch {
    // The engine's message would quote the pattern into a public CI log.
    throw new Error('vendor guard: VENDOR_PATTERN does not compile')
  }
  if (pattern.test('')) throw new Error('vendor guard: VENDOR_PATTERN matches everything')
  // Positive control: the guard names the providers it guards against, so a
  // pattern that misses its own file would miss them everywhere.
  if (!pattern.test(guard)) {
    throw new Error('vendor guard: VENDOR_PATTERN matches nothing in its own guard')
  }
  return pattern
}

export function findDisclosures(pattern: RegExp, file: string, text: string): Disclosure[] {
  const lines = new Set<number>()
  const lockfile = file.endsWith('pnpm-lock.yaml')
  text.split('\n').forEach((line, index) => {
    // Strip only the hash, so a tarball URL on the same line is still scanned.
    const scanned = lockfile ? line.replace(INTEGRITY_TOKEN, '') : line
    if (pattern.test(scanned)) lines.add(index + 1)
  })
  if (!lockfile) for (const line of joinedHits(pattern, text)) lines.add(line)
  return [...lines].sort((a, b) => a - b).map((line) => ({ file, line }))
}

/**
 * Lines where a name split across string literals, and joined at runtime,
 * matches. Each hit is reported on the line where the joined match starts.
 */
function joinedHits(pattern: RegExp, text: string): number[] {
  // Where each kept stretch of text starts, in the joined text and in the original.
  const stretches = [{ joined: 0, original: 0 }]
  let joined = ''
  let last = 0
  for (const seam of text.matchAll(LITERAL_SEAM)) {
    joined += text.slice(last, seam.index)
    last = seam.index + seam[0].length
    stretches.push({ joined: joined.length, original: last })
  }
  if (stretches.length === 1) return []
  joined += text.slice(last)

  const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`)
  return [...joined.matchAll(global)].map((match) => {
    let stretch = stretches[0] as { joined: number; original: number }
    for (const s of stretches) if (s.joined <= match.index) stretch = s
    const original = stretch.original + match.index - stretch.joined
    return text.slice(0, original).split('\n').length
  })
}

/** Every file git would commit, plus the build output that npm publishes. */
function publishedFiles(requireDist: boolean): string[] {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
  const tracked = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    // --cached still lists a file deleted from the working tree.
    .filter((file) => file !== '' && existsSync(join(REPO_ROOT, file)))
  const dist = join(REPO_ROOT, 'dist')
  if (requireDist && !existsSync(dist)) throw new Error('dist/ is missing; run pnpm build first')
  return [...tracked, ...(existsSync(dist) ? walk(dist).map((f) => relative(REPO_ROOT, f)) : [])]
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function main(): void {
  const apiSpecDir = process.env.TGBP_API_SPEC_DIR
  if (!apiSpecDir) {
    console.error('Set TGBP_API_SPEC_DIR to a checkout of the private API spec repo')
    process.exit(2)
  }
  const pattern = loadVendorPattern(vendorGuardPath(resolve(apiSpecDir)))
  const files = publishedFiles(process.argv.includes('--require-dist'))
  // An empty list would pass while sweeping nothing.
  if (files.length === 0) throw new Error('Disclosure sweep found no files to scan')
  const hits = files.flatMap((file) =>
    findDisclosures(pattern, file, readFileSync(join(REPO_ROOT, file), 'utf8')),
  )
  if (hits.length > 0) {
    for (const hit of hits) console.error(`${hit.file}:${hit.line}: provider name`)
    console.error(`Disclosure sweep failed: ${hits.length} line(s) name a provider.`)
    process.exit(1)
  }
  console.log(`Disclosure sweep passed: ${files.length} files, no provider names.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
