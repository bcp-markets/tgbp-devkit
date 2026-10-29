/**
 * Writes a Markdown copy of each developer-site page beside it, served at the
 * page's path plus `.md` (`/quickstart.md`, and `/index.md` for the home page),
 * for AI agents that read Markdown rather than HTML. test/site.test.ts fails
 * when a copy has drifted from its page: run `pnpm generate:site-md`.
 *
 * The converter reads only the elements the site uses and throws on any
 * other, so new markup cannot drop out of the copies unseen.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SITE_DIR = join(import.meta.dirname, '../site/public')
const ORIGIN = 'https://dev.tokenisedgbp.com'

interface Element {
  tag: string
  attrs: Record<string, string>
  children: Node[]
}
type Node = Element | string

const VOID = new Set(['img', 'input', 'br'])
const BLOCK = new Set(['h1', 'h2', 'h3', 'p', 'pre', 'ul', 'ol', 'table', 'div', 'aside'])
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/** The pages that get a copy: every page but the 404. */
export function sitePages(dir = SITE_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.html') && file !== '404.html')
    .sort()
}

/** `quickstart.html` → `quickstart.md`. */
export function markdownFileOf(htmlFile: string): string {
  return htmlFile.replace(/\.html$/, '.md')
}

/** The Markdown copy of one page: its `<main>`, converted. */
export function toMarkdown(html: string): string {
  const main = html.match(/<main>([\s\S]*)<\/main>/)?.[1]
  if (main === undefined) throw new Error('page has no <main>')
  return `${blocks(parse(main)).join('\n\n')}\n`
}

function parse(html: string): Node[] {
  const root: Element = { tag: 'root', attrs: {}, children: [] }
  const stack = [root]
  // A lone `<` is any other markup: a comment, a doctype, an uppercase tag.
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|[^<]+|</g)) {
    const [token, close, tag, rest] = match
    const parent = stack.at(-1) as Element
    if (token === '<') {
      throw new Error(`no Markdown for "${html.slice(match.index, match.index + 12)}"`)
    } else if (!tag) {
      parent.children.push(token)
    } else if (close) {
      if (parent.tag !== tag) throw new Error(`</${tag}> closes <${parent.tag}>`)
      stack.pop()
    } else {
      const attrs = Object.fromEntries(
        [...(rest ?? '').matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [
          k,
          decode(v ?? ''),
        ]),
      ) as Record<string, string>
      const element: Element = { tag, attrs, children: [] }
      parent.children.push(element)
      if (!VOID.has(tag)) stack.push(element)
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack.at(-1)?.tag}> is never closed`)
  return root.children
}

function decode(text: string): string {
  return text.replace(/&[a-z0-9#]+;/g, (entity) => {
    const char = ENTITIES[entity]
    if (char === undefined) throw new Error(`unknown entity ${entity}`)
    return char
  })
}

function textOf(node: Node): string {
  return typeof node === 'string' ? decode(node) : node.children.map(textOf).join('')
}

/** Renders nodes as Markdown blocks; a run of inline nodes becomes one paragraph. */
function blocks(nodes: Node[]): string[] {
  const out: string[] = []
  let run: Node[] = []
  const flush = () => {
    const text = inline(run)
    if (text) out.push(text)
    run = []
  }
  for (const node of nodes) {
    if (typeof node !== 'string' && BLOCK.has(node.tag)) {
      flush()
      out.push(block(node))
    } else {
      run.push(node)
    }
  }
  flush()
  return out
}

function block(element: Element): string {
  const { tag, children } = element
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
      return `${'#'.repeat(Number(tag[1]))} ${inline(children)}`
    case 'p':
      return inline(children)
    case 'pre': {
      const code = textOf(element).replace(/\n$/, '')
      return `\`\`\`\n${code}\n\`\`\``
    }
    case 'ul':
    case 'ol':
      return elements(children, 'li')
        .map((li, i) => {
          const marker = tag === 'ol' ? `${i + 1}. ` : '- '
          const body = blocks(li.children).join('\n\n')
          return marker + body.replaceAll('\n', `\n${' '.repeat(marker.length)}`)
        })
        .join('\n')
    case 'div':
    case 'aside':
      return blocks(children)
        .join('\n\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')
    case 'table': {
      const rows = elements(children, 'thead', 'tbody')
        .flatMap((section) => elements(section.children, 'tr'))
        .map((tr) => elements(tr.children, 'th', 'td').map((cell) => inline(cell.children)))
      const [head = [], ...body] = rows
      return [head, head.map(() => '---'), ...body]
        .map((cells) => `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`)
        .join('\n')
    }
    default:
      throw new Error(`no Markdown for <${tag}>`)
  }
}

/** The element children, refusing anything but whitespace and the tags allowed. */
function elements(nodes: Node[], ...tags: string[]): Element[] {
  return nodes.filter((node): node is Element => {
    if (typeof node === 'string') {
      if (node.trim()) throw new Error(`text "${node.trim()}" outside <${tags.join('|')}>`)
      return false
    }
    if (!tags.includes(node.tag)) throw new Error(`<${node.tag}> where <${tags.join('|')}> belongs`)
    return true
  })
}

function inline(nodes: Node[]): string {
  return nodes.map(inlineNode).join('').replace(/\s+/g, ' ').trim()
}

function inlineNode(node: Node): string {
  if (typeof node === 'string') return decode(node)
  switch (node.tag) {
    case 'code':
      return `\`${textOf(node)}\``
    case 'strong':
      return `**${inline(node.children)}**`
    case 'a':
      return `[${inline(node.children)}](${markdownUrl(node.attrs.href ?? '')})`
    case 'form': {
      // A form cannot work in Markdown, so say where it sends what.
      const fields: string[] = []
      for (const child of descendants(node)) {
        if (child.tag === 'input' && child.attrs.name) fields.push(`\`${child.attrs.name}\``)
        else if (child.tag !== 'label' && child.tag !== 'button') {
          throw new Error(`no Markdown for <${child.tag}> in a form`)
        }
      }
      const method = (node.attrs.method ?? 'get').toUpperCase()
      return ` (The form sends ${fields.join(', ')} by ${method} to ${markdownUrl(node.attrs.action ?? '')}.) `
    }
    default:
      throw new Error(`no Markdown for <${node.tag}>`)
  }
}

function descendants(element: Element): Element[] {
  return element.children.flatMap((child) =>
    typeof child === 'string' ? [] : [child, ...descendants(child)],
  )
}

/** Site pages link to their Markdown copies; files and other sites keep their URL. */
function markdownUrl(href: string): string {
  if (!href.startsWith('/')) return href
  const path = href.split('#')[0] as string
  if (path === '/') return `${ORIGIN}/index.md`
  return path.includes('.') || path.startsWith('/api/') ? `${ORIGIN}${path}` : `${ORIGIN}${path}.md`
}

function main(): void {
  for (const page of sitePages()) {
    const file = markdownFileOf(page)
    writeFileSync(join(SITE_DIR, file), toMarkdown(readFileSync(join(SITE_DIR, page), 'utf8')))
    console.log(`Wrote site/public/${file}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
