/**
 * Fails when src/registry/tokens.generated.ts no longer matches the tGBP
 * contracts repo it was generated from. That repo is private, so this needs a
 * checkout of it in TGBP_SOURCE_DIR, with TGBP_REGISTRY_CHAINS and
 * TGBP_REGISTRY_SOLANA naming the registry files in it: CI's registry-drift
 * job provides all three. Without them the test skips, unless
 * TGBP_REQUIRE_SOURCE=1 makes the missing source a failure (CI sets that, so a
 * broken checkout cannot pass silently).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildRegistry,
  GENERATED_PATH,
  type RegistrySources,
  registrySourcesFromEnv,
  renderRegistry,
} from '../scripts/generate-registry.js'

const sourceDir = process.env.TGBP_SOURCE_DIR ? resolve(process.env.TGBP_SOURCE_DIR) : undefined
const sources = registrySourcesFromEnv()
const available = sourceDir !== undefined && existsSync(sourceDir) && sources !== undefined
const required = process.env.TGBP_REQUIRE_SOURCE === '1'

describe('token registry drift', () => {
  it.runIf(required && !available)('has the tGBP source checkout it requires', () => {
    expect.fail(
      'TGBP_REQUIRE_SOURCE=1 but TGBP_SOURCE_DIR is not a directory or a TGBP_REGISTRY_* path is unset',
    )
  })

  it.runIf(available)('matches the tGBP deployments and chain registry', () => {
    const expected = renderRegistry(buildRegistry(sourceDir as string, sources as RegistrySources))
    expect(
      readFileSync(GENERATED_PATH, 'utf8'),
      'tokens.generated.ts has drifted from the tGBP contracts; run pnpm generate:registry',
    ).toBe(expected)
  })
})
