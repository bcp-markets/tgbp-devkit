/**
 * Fails when the generated API types no longer match the spec commit pinned in
 * api-spec.lock. The spec repo is private, so this needs a checkout of it in
 * TGBP_API_SPEC_DIR: CI's api-drift job checks out the pinned commit. Without
 * it the test skips, unless TGBP_REQUIRE_SOURCE=1 makes the missing source a
 * failure (CI sets that, so a broken checkout cannot pass silently).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildApiTypes, LOCK_PATH, specCommit } from '../scripts/generate-api.js'

const apiSpecDir = process.env.TGBP_API_SPEC_DIR
  ? resolve(process.env.TGBP_API_SPEC_DIR)
  : undefined
const available = apiSpecDir !== undefined && existsSync(apiSpecDir)
const required = process.env.TGBP_REQUIRE_SOURCE === '1'

describe('API types drift', () => {
  it.runIf(required && !available)('has the API spec checkout it requires', () => {
    expect.fail(`TGBP_REQUIRE_SOURCE=1 but TGBP_API_SPEC_DIR (${apiSpecDir}) is not a directory`)
  })

  it.runIf(available)('is checked out at the pinned commit', () => {
    expect(specCommit(apiSpecDir as string)).toBe(readFileSync(LOCK_PATH, 'utf8').trim())
  })

  it.runIf(available)('matches the pinned spec', async () => {
    for (const [path, rendered] of await buildApiTypes(apiSpecDir as string)) {
      expect(
        readFileSync(path, 'utf8'),
        `${path} has drifted from the pinned spec; run pnpm generate:api`,
      ).toBe(rendered)
    }
  })
})
