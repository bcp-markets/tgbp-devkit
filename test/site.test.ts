import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SITE = join(import.meta.dirname, '../site/public')
const EXAMPLES = join(import.meta.dirname, '../examples/quickstart')
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
  it('lists every page in llms.txt', () => {
    for (const file of htmlFiles.filter((file) => file !== '404.html')) {
      expect(llms, file).toContain(`(${ORIGIN}${pathOf(file)})`)
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

  it('shows each quickstart script exactly as it is in examples/', () => {
    const page = read(SITE, 'quickstart.html')
    for (const file of readdirSync(EXAMPLES).filter((file) => file.endsWith('.mjs'))) {
      const escaped = read(EXAMPLES, file)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
      expect(page, file).toContain(`<pre><code>${escaped}</code></pre>`)
    }
  })
})
