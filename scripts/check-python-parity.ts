/**
 * Checks that the Python client in python/ exposes every operation the
 * TypeScript API client does, under the same name in snake_case, and nothing
 * the TypeScript client lacks.
 *
 *   PYTHON=python/.venv/bin/python pnpm check:python-parity
 *
 * PYTHON names an interpreter with the tgbp_kit package installed (default python3).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createTgbpClient, createTgbpSwapClient } from '../src/api/index.js'

/** Every function on a client, as dotted paths: `mints.create`, `getQuote`. */
export function tsOperations(client: object, prefix = ''): string[] {
  return Object.entries(client)
    .flatMap(([name, value]) =>
      typeof value === 'function'
        ? [prefix + name]
        : typeof value === 'object' && value !== null
          ? tsOperations(value, `${prefix}${name}.`)
          : [],
    )
    .sort()
}

export const snakeCase = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

export function compare(ts: string[], python: string[]): string[] {
  const expected = new Set(ts.map(snakeCase))
  const actual = new Set(python)
  return [
    ...[...expected].filter((op) => !actual.has(op)).map((op) => `missing in Python: ${op}`),
    ...[...actual].filter((op) => !expected.has(op)).map((op) => `only in Python: ${op}`),
  ]
}

function main(): void {
  const ts = {
    TgbpClient: tsOperations(createTgbpClient({ apiKey: 'parity', environment: 'sandbox' })),
    TgbpSwapClient: tsOperations(createTgbpSwapClient({ apiKey: 'parity' })),
  }
  const script = fileURLToPath(new URL('../python/scripts/list_methods.py', import.meta.url))
  const python = JSON.parse(
    execFileSync(process.env.PYTHON ?? 'python3', [script], { encoding: 'utf8' }),
  ) as Record<keyof typeof ts, string[]>
  const problems = Object.entries(ts).flatMap(([client, ops]) =>
    compare(ops, python[client as keyof typeof ts] ?? []).map((p) => `${client}: ${p}`),
  )
  for (const [client, ops] of Object.entries(ts)) {
    console.log(`${client}: ${ops.length} operations in TypeScript`)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  console.log('The Python client covers every TypeScript API operation.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
