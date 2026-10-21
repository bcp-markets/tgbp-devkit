import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SITE = join(import.meta.dirname, '../site/public')
const EXAMPLES = join(import.meta.dirname, '../examples/quickstart')
const ORIGIN = 'https://dev.tokenisedgbp.com'

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8')
const htmlFiles = readdirSync(SITE).filter((file) => file.endsWith('.html'))
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
  it('lists every page in llms.txt', () => {
    for (const file of htmlFiles.filter((file) => file !== '404.html')) {
      expect(llms, file).toContain(`(${ORIGIN}${pathOf(file)})`)
    }
  })

  it('has a page for every site link in llms.txt', () => {
    const links = [...llms.matchAll(/\(https:\/\/dev\.tokenisedgbp\.com(\/[^)]*)\)/g)]
    expect(links.length).toBeGreaterThan(0)
    for (const [, path] of links) expect(readdirSync(SITE), path).toContain(fileOf(path as string))
  })

  it('resolves every internal link', () => {
    for (const file of htmlFiles) {
      for (const [, href] of read(SITE, file).matchAll(/href="(\/[^"#]*)/g)) {
        expect(readdirSync(SITE), `${file} → ${href}`).toContain(fileOf(href as string))
      }
    }
  })

  it('shows each quickstart script exactly as it is in examples/', () => {
    const page = read(SITE, 'quickstart.html')
    for (const file of readdirSync(EXAMPLES)) {
      const escaped = read(EXAMPLES, file)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
      expect(page, file).toContain(`<pre><code>${escaped}</code></pre>`)
    }
  })
})
