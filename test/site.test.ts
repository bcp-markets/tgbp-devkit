import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { markdownFileOf, sitePages, toMarkdown } from '../scripts/generate-site-md.js'

const SITE = join(import.meta.dirname, '../site/public')
const EXAMPLES = join(import.meta.dirname, '../examples/quickstart')
const PYTHON_EXAMPLES = join(import.meta.dirname, '../examples/python-quickstart')
const ORIGIN = 'https://dev.tokenisedgbp.com'

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8')
const siteFiles = readdirSync(SITE, { recursive: true, encoding: 'utf8' })
const htmlFiles = siteFiles.filter((file) => file.endsWith('.html'))
const llms = read(SITE, 'llms.txt')

// `quickstart.html` is served at `/quickstart`, `index.html` at `/`.
function pathOf(file: string): string {
  const slug = file.replace(/\.html$/, '')
  return slug === 'index' ? '/' : `/${slug}`
}

function fileOf(path: string): string {
  if (path === '/') return 'index.html'
  const name = path.slice(1)
  return name.includes('.') ? name : `${name}.html`
}

describe('developer site', () => {
  it('lists every page in llms.txt, by its Markdown copy', () => {
    expect(sitePages()).toEqual(htmlFiles.filter((file) => file !== '404.html').sort())
    for (const file of sitePages()) {
      expect(llms, file).toContain(`(${ORIGIN}/${markdownFileOf(file)})`)
    }
  })

  it('serves a current Markdown copy of every page', () => {
    for (const file of sitePages()) {
      expect(read(SITE, markdownFileOf(file)), `${file}: run pnpm generate:site-md`).toBe(
        toMarkdown(read(SITE, file)),
      )
    }
  })

  it('tells AI readers on every page where its Markdown copy is and what to install', () => {
    for (const file of sitePages()) {
      const page = read(SITE, file)
      const md = `/${markdownFileOf(file)}`
      expect(page, file).toContain(`<link rel="alternate" type="text/markdown" href="${md}">`)
      const aside = page.match(/<aside class="agents"[\s\S]*?<\/aside>/)?.[0] ?? ''
      expect(aside, file).toContain(`<a href="${md}">`)
      expect(aside, file).toContain('<code>tgbp-mcp</code> MCP server and the agent skills')
      expect(aside, file).toContain('Start on testnet')
    }
  })

  it('has a page for every site link in llms.txt', () => {
    const links = [...llms.matchAll(/\(https:\/\/dev\.tokenisedgbp\.com(\/[^)]*)\)/g)]
    expect(links.length).toBeGreaterThan(0)
    for (const [, path] of links) expect(siteFiles, path).toContain(fileOf(path as string))
  })

  it('resolves every internal link', () => {
    for (const file of htmlFiles) {
      for (const [, href] of read(SITE, file).matchAll(/href="(\/[^"#]*)/g)) {
        expect(siteFiles, `${file} → ${href}`).toContain(fileOf(href as string))
      }
    }
  })

  // A bare word such as a placeholder would resolve as a relative path and 404.
  it('links only to https URLs or site paths', () => {
    for (const file of htmlFiles) {
      for (const [, href] of read(SITE, file).matchAll(/href="([^"]*)"/g)) {
        expect(href, file).toMatch(/^(https:\/\/|\/|#)/)
      }
    }
  })

  it('shows the logo, linked home, in the header of every page', () => {
    for (const file of htmlFiles) {
      expect(read(SITE, file), file).toContain(
        '<a class="home" href="/"><img src="/assets/tgbp-logo.svg" alt="tGBP"',
      )
    }
  })

  it('sets the favicon, apple-touch-icon and theme colour on every page', () => {
    for (const file of htmlFiles) {
      const page = read(SITE, file)
      expect(page, file).toContain('<link rel="icon" type="image/png" href="/assets/favicon.png">')
      expect(page, file).toContain(
        '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">',
      )
      expect(page, file).toContain('<meta name="theme-color"')
    }
  })

  it('gives every indexed page share tags that match its title and description', () => {
    for (const file of htmlFiles.filter((file) => file !== '404.html')) {
      const page = read(SITE, file)
      const title = page.match(/<title>([^<]*)<\/title>/)?.[1]
      const description = page.match(/<meta name="description" content="([^"]*)">/)?.[1]
      const meta = (attr: string, key: string) =>
        page.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))?.[1]
      expect(meta('property', 'og:title'), file).toBe(title)
      expect(meta('property', 'og:description'), file).toBe(description)
      expect(meta('property', 'og:url'), file).toBe(`${ORIGIN}${pathOf(file)}`)
      expect(meta('name', 'twitter:card'), file).toBe('summary_large_image')
      expect(meta('name', 'twitter:title'), file).toBe(title)
      expect(meta('name', 'twitter:description'), file).toBe(description)
      for (const key of ['og:image', 'twitter:image']) {
        const attr = key.startsWith('og:') ? 'property' : 'name'
        expect(meta(attr, key), `${file} ${key}`).toBe(`${ORIGIN}/assets/social-card.png`)
      }
    }
  })

  // The CSP allows images from 'self' only.
  it('loads every image from the site itself', () => {
    for (const file of htmlFiles) {
      for (const [, src] of read(SITE, file).matchAll(/src="([^"]*)"/g)) {
        expect(src, file).toMatch(/^\//)
        expect(siteFiles, `${file} → ${src}`).toContain((src as string).slice(1))
      }
    }
  })

  // The repo is public: an asset must not name the tool or person that made it.
  it('ships assets without embedded metadata', () => {
    for (const file of siteFiles.filter((file) => file.startsWith('assets/'))) {
      const bytes = readFileSync(join(SITE, file))
      if (file.endsWith('.png')) {
        for (const chunk of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']) {
          expect(bytes.includes(chunk), `${file} has a ${chunk} chunk`).toBe(false)
        }
      } else if (file.endsWith('.svg')) {
        expect(bytes.toString('utf8'), file).not.toMatch(/<metadata|<!--|inkscape|sodipodi|figma/i)
      }
    }
  })

  it.each([
    ['quickstart.html', EXAMPLES, '.mjs'],
    ['python.html', PYTHON_EXAMPLES, '.py'],
  ])('shows each script on %s exactly as it is in examples/', (pageFile, dir, ext) => {
    const page = read(SITE, pageFile)
    for (const file of readdirSync(dir).filter((file) => file.endsWith(ext))) {
      const escaped = read(dir, file)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
      expect(page, file).toContain(`<pre><code>${escaped}</code></pre>`)
    }
  })
})

describe('toMarkdown', () => {
  const page = (main: string) => `<html><body><main>${main}</main></body></html>`

  it('links site pages to their Markdown copies and keeps other URLs', () => {
    expect(
      toMarkdown(
        page(
          '<p><a href="/">Home</a> <a href="/brand#x">Brand</a> <a href="/llms.txt">llms</a> <a href="https://x402.org">x402</a></p>',
        ),
      ),
    ).toBe(
      `[Home](${ORIGIN}/index.md) [Brand](${ORIGIN}/brand.md) [llms](${ORIGIN}/llms.txt) [x402](https://x402.org)\n`,
    )
  })

  it('converts tables, notes, lists and code', () => {
    expect(
      toMarkdown(
        page(`<h2 id="a">A &amp; B</h2>
<table><thead><tr><th>Key</th><th>Use</th></tr></thead><tbody><tr><td><code>a|b</code></td><td>x</td></tr></tbody></table>
<div class="warning" role="note"><strong>Note.</strong> Two
  lines.</div>
<ol><li>One</li><li>Two <form method="post" action="/api/faucet"><input name="address"></form></li></ol>
<pre><code>x &lt; 1
</code></pre>`),
      ),
    ).toBe(`## A & B

| Key | Use |
| --- | --- |
| \`a\\|b\` | x |

> **Note.** Two lines.

1. One
2. Two (The form sends \`address\` by POST to ${ORIGIN}/api/faucet.)

\`\`\`
x < 1
\`\`\`
`)
  })

  it.each([
    ['an element it has no Markdown for', '<p><em>x</em></p>', 'no Markdown for <em>'],
    ['an unknown entity', '<p>&nbsp;</p>', 'unknown entity &nbsp;'],
    ['a mismatched close tag', '<p><code>x</p>', '</p> closes <code>'],
    ['an unclosed element', '<p>x', '<p> is never closed'],
    ['text loose in a list', '<ul>x<li>y</li></ul>', 'text "x" outside <li>'],
  ])('throws on %s', (_, main, message) => {
    expect(() => toMarkdown(page(main))).toThrow(message)
  })
})
