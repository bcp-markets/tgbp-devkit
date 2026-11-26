/**
 * Serves the agent skills in skills.generated.ts over the MCP Skills
 * extension, so an agent wired to this server finds the integration guide
 * without a separate install. A client that does not support skills never
 * calls the methods: its tools are unchanged, and it sees only the skills
 * resource template and the resources capability it needs.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { type Skill, SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills'

import { SKILL_FILES } from './skills.generated.js'

const BASE_URI = 'skill://'

/** Each skill's files, keyed by path under its folder, grouped by skill. */
function bySkill(): Map<string, Record<string, string>> {
  const skills = new Map<string, Record<string, string>>()
  for (const [path, text] of Object.entries(SKILL_FILES)) {
    const slash = path.indexOf('/')
    const skill = path.slice(0, slash)
    const files = skills.get(skill) ?? {}
    files[path.slice(slash + 1)] = text
    skills.set(skill, files)
  }
  return skills
}

let entries: Promise<Skill[]> | undefined
/** Built once, on first use: the files never change while the process runs. */
function skillEntries(): Promise<Skill[]> {
  entries ??= Promise.all(
    [...bySkill()].map(([skill, files]) => skillEntry(skill, files, { baseUri: BASE_URI })),
  )
  return entries
}

/** One extension serves every server this process builds. */
const skills = new SkillsExtension({
  baseUri: BASE_URI,
  source: {
    list: async () => ({ skills: await skillEntries() }),
    get: async (uri) => (await skillEntries()).find((skill) => skill.uri === uri),
    read: async (uri) => {
      const path = uri.startsWith(BASE_URI) ? uri.slice(BASE_URI.length) : undefined
      // hasOwn, so a URI such as skill://constructor cannot read the object's prototype.
      if (path === undefined || !Object.hasOwn(SKILL_FILES, path)) return undefined
      const text = SKILL_FILES[path] as string
      return path.endsWith('.md') ? { text, mimeType: 'text/markdown' } : { text }
    },
  },
})

/** Declares the skills extension on `server` and serves the skills. Call before connecting. */
export function serveSkills(server: McpServer): void {
  skills.attach(server)
}
