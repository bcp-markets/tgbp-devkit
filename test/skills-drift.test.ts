/**
 * Fails when the skills the MCP server serves no longer match the agent-skills
 * commit pinned in agent-skills.lock. That repo is private, so this needs a
 * checkout of it in TGBP_AGENT_SKILLS_DIR: CI's skills-drift job checks out the
 * pinned commit. Without it the test skips, unless TGBP_REQUIRE_SOURCE=1 makes
 * the missing source a failure (CI sets that, so a broken checkout cannot pass
 * silently).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LOCK_PATH,
  OUTPUT_PATH,
  renderSkillsModule,
  skillsCommit,
} from '../scripts/vendor-skills.js'

const skillsDir = process.env.TGBP_AGENT_SKILLS_DIR
  ? resolve(process.env.TGBP_AGENT_SKILLS_DIR)
  : undefined
const available = skillsDir !== undefined && existsSync(skillsDir)
const required = process.env.TGBP_REQUIRE_SOURCE === '1'

describe('served skills drift', () => {
  it.runIf(required && !available)('has the agent-skills checkout it requires', () => {
    expect.fail(`TGBP_REQUIRE_SOURCE=1 but TGBP_AGENT_SKILLS_DIR (${skillsDir}) is not a directory`)
  })

  it.runIf(available)('is checked out at the pinned commit', () => {
    expect(skillsCommit(skillsDir as string)).toBe(readFileSync(LOCK_PATH, 'utf8').trim())
  })

  it.runIf(available)('matches the pinned skills', () => {
    expect(
      readFileSync(OUTPUT_PATH, 'utf8'),
      `${OUTPUT_PATH} has drifted from agent-skills; run pnpm generate:skills`,
    ).toBe(renderSkillsModule(skillsDir as string))
  })
})
