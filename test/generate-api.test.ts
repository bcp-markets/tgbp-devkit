import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { findDisclosures, loadVendorPattern, vendorGuardPath } from '../scripts/disclosure.js'
import { pruneSpec, renderSpec } from '../scripts/generate-api.js'

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0', description: 'Confidential prose.' },
  paths: {
    '/things': {
      post: {
        operationId: 'createThing',
        summary: 'Create a thing',
        description: 'Long reference prose.',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
        },
        responses: { '201': { $ref: '#/components/responses/Created' } },
      },
      get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
    },
    '/admin': { get: { operationId: 'adminOnly', responses: {} } },
  },
  components: {
    schemas: {
      Thing: {
        type: 'object',
        description: 'Schema prose.',
        example: { name: 'x' },
        'x-internal': true,
        properties: {
          name: { type: 'string', description: 'Field prose.' },
          description: { type: 'string' },
          part: { $ref: '#/components/schemas/Part' },
        },
      },
      Part: { type: 'string', enum: ['a', 'b'] },
      Unused: { type: 'string' },
    },
    responses: {
      Created: {
        description: 'Created',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
      },
    },
    securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
  },
}

describe('pruneSpec', () => {
  const pruned = pruneSpec(SPEC as never, ['createThing']) as typeof SPEC

  it('keeps only the named operations and the components they reach', () => {
    expect(Object.keys(pruned.paths)).toEqual(['/things'])
    expect(Object.keys(pruned.paths['/things'])).toEqual(['post'])
    expect(Object.keys(pruned.components.schemas)).toEqual(['Part', 'Thing'])
    expect(Object.keys(pruned.components.responses)).toEqual(['Created'])
    expect(pruned.components).not.toHaveProperty('securitySchemes')
  })

  it('drops reference prose and extensions, but keeps a field named description', () => {
    const text = JSON.stringify(pruned)
    for (const prose of ['Confidential', 'Long reference', 'Schema prose', 'Field prose']) {
      expect(text).not.toContain(prose)
    }
    expect(text).not.toContain('x-internal')
    expect(text).not.toContain('"example"')
    expect(pruned.components.schemas.Thing.properties).toHaveProperty('description')
  })

  it('throws when an operation is missing, so an upstream rename fails loudly', () => {
    expect(() => pruneSpec(SPEC as never, ['createThing', 'renamedAway'])).toThrow(/renamedAway/)
  })

  it('throws when the spec has no paths object', () => {
    expect(() => pruneSpec({ openapi: '3.0.0' } as never, ['createThing'])).toThrow(/no paths/)
  })

  it('throws on a duplicate wanted operationId, rather than typing one of them', () => {
    const spec = {
      ...SPEC,
      paths: { ...SPEC.paths, '/other': { put: { operationId: 'createThing', responses: {} } } },
    }
    expect(() => pruneSpec(spec as never, ['createThing'])).toThrow(
      /duplicate operationId createThing/,
    )
  })

  it('renders types for the kept operations only', async () => {
    const rendered = await renderSpec(SPEC as never, 'test.yaml', ['createThing'])
    expect(rendered).toContain('createThing')
    expect(rendered).not.toContain('adminOnly')
    expect(rendered).not.toContain('listThings')
  })
})

function loadVendorPatternError(dir: string): string {
  try {
    loadVendorPattern(dir)
  } catch (error) {
    return String(error)
  }
  return ''
}

describe('disclosure sweep', () => {
  function guardDir(source: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'api-spec-')), 'guard.js')
    writeFileSync(path, source)
    return path
  }

  it('reads the pattern from the vendor-name guard', () => {
    const dir = guardDir(
      '// acme bank\nconst VENDOR_PATTERN =\n  /(?:acme[\\s._-]*bank|\\bab\\b)/i;\n',
    )
    const pattern = loadVendorPattern(dir)
    expect(pattern.test('Paid via ACME Bank')).toBe(true)
    expect(pattern.test('ab_123')).toBe(false)
    expect(pattern.test('see ab here')).toBe(true)
  })

  it('refuses a pattern that matches everything, and never echoes a broken one', () => {
    expect(() => loadVendorPattern(guardDir('const VENDOR_PATTERN = /(?:)/i;\n'))).toThrow(
      /matches everything/,
    )
    const broken = loadVendorPatternError(guardDir('const VENDOR_PATTERN = /secretname(/i;\n'))
    expect(broken).toMatch(/does not compile/)
    expect(broken).not.toContain('secretname')
  })

  it('refuses a pattern that matches nothing in its own guard, without echoing it', () => {
    // A literal pattern always matches its own source line, so this one needs regex syntax.
    const error = loadVendorPatternError(guardDir('const VENDOR_PATTERN = /zz\\d{3}q/i;\n'))
    expect(error).toMatch(/matches nothing in its own guard/)
    expect(error).not.toContain('zz')
  })

  it('skips lockfile integrity hashes but still scans the rest of the line', () => {
    const lock = [
      '  resolution: {integrity: sha512-x+ab/y==}',
      '  /ab@1.0.0:',
      '  resolution: {integrity: sha512-x+ab/y==, tarball: https://ab.example/x.tgz}',
    ].join('\n')
    expect(findDisclosures(/\bab\b/, 'pnpm-lock.yaml', lock)).toEqual([
      { file: 'pnpm-lock.yaml', line: 2 },
      { file: 'pnpm-lock.yaml', line: 3 },
    ])
  })

  it('refuses a guard it cannot read, without echoing its path', () => {
    const error = loadVendorPatternError(join(tmpdir(), 'secret-guard-path', 'guard.js'))
    expect(error).toMatch(/cannot read/)
    expect(error).not.toContain('secret-guard-path')
  })

  it('throws when the guard no longer has the pattern, rather than sweeping nothing', () => {
    expect(() => loadVendorPattern(guardDir('module.exports = {}\n'))).toThrow(/VENDOR_PATTERN/)
  })

  it('reports file and line, never the matched text', () => {
    const hits = findDisclosures(/acme/i, 'src/x.ts', 'ok\nfrom Acme\nok\nACME again')
    expect(hits).toEqual([
      { file: 'src/x.ts', line: 2 },
      { file: 'src/x.ts', line: 4 },
    ])
  })

  it('catches a name split into string literals, whatever joins them at runtime', () => {
    const source = [
      "const a = ['Ac', 'me'].join('')",
      'const b = "Ac" + "me"',
      'const c = [',
      "  'Ac',",
      "  'me',",
      "].join('')",
      "const d = ['Ac', 'me'].join(' ')",
    ].join('\n')
    expect(findDisclosures(/acme/i, 'test/x.ts', source)).toEqual([
      { file: 'test/x.ts', line: 1 },
      { file: 'test/x.ts', line: 2 },
      { file: 'test/x.ts', line: 4 },
      { file: 'test/x.ts', line: 7 },
    ])
  })

  it('reports a joined hit once, on a line that also matches whole', () => {
    expect(findDisclosures(/acme/i, 'x.ts', "Acme ['Ac', 'me']")).toEqual([
      { file: 'x.ts', line: 1 },
    ])
  })

  it('reads the guard path from TGBP_VENDOR_GUARD, and refuses to run without it', () => {
    vi.stubEnv('TGBP_VENDOR_GUARD', 'tools/guard.js')
    expect(vendorGuardPath('/spec')).toBe(join('/spec', 'tools/guard.js'))
    vi.stubEnv('TGBP_VENDOR_GUARD', '')
    expect(() => vendorGuardPath('/spec')).toThrow(/TGBP_VENDOR_GUARD/)
    vi.unstubAllEnvs()
  })
})
