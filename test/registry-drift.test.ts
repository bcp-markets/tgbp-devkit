/**
 * Fails when src/registry/tokens.generated.ts no longer matches the tGBP
 * repo it was generated from. bcp-markets/tGBP is private, so this needs a
 * checkout of it in TGBP_SOURCE_DIR: CI's registry-drift job provides one.
 * Without it the test skips, unless TGBP_REQUIRE_SOURCE=1 makes the missing
 * source a failure (CI sets that, so a broken checkout cannot pass silently).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildRegistry, GENERATED_PATH, renderRegistry } from '../scripts/generate-registry.js'

const sourceDir = process.env.TGBP_SOURCE_DIR ? resolve(process.env.TGBP_SOURCE_DIR) : undefined
const available = sourceDir !== undefined && existsSync(sourceDir)
const required = process.env.TGBP_REQUIRE_SOURCE === '1'

describe('token registry drift', () => {
  it.runIf(required && !available)('has the tGBP source checkout it requires', () => {
    expect.fail(`TGBP_REQUIRE_SOURCE=1 but TGBP_SOURCE_DIR (${sourceDir}) is not a directory`)
  })

  it.runIf(available)('matches the tGBP deployments and chain registry', () => {
    const expected = renderRegistry(buildRegistry(sourceDir as string))
    expect(
      readFileSync(GENERATED_PATH, 'utf8'),
      'tokens.generated.ts has drifted from bcp-markets/tGBP; run pnpm generate:registry',
    ).toBe(expected)
  })
})
