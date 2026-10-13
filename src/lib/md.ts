// Markdown, the small subset a chat answer actually uses.
//
// The Analyst renders model output, so the dialect is tiny: headings, lists,
// quotes, fences, tables and paragraphs, with emphasis, code and links inline.
// Parsing it here rather than shipping a parser keeps three promises:
//
//   1. No HTML ever enters the pipeline. The parser emits data, the renderer
//      turns that data into React elements, so an answer full of <script> is
//      text on screen and nothing else.
//   2. Streaming is not a special case. An unterminated fence stays open and
//      renders as code, which is exactly what a half-arrived block should look
//      like while it is still arriving.
//   3. The parser is pure and dependency-free, so it can be exercised without
//      a browser (see the smoke test in tools/).

export type InlineKind = 'text' | 'code' | 'strong' | 'em' | 'del' | 'link'

export interface InlineToken {
  t: InlineKind
  v: string
  /** Present on links, already vetted: anything but http/https/mailto is dropped. */
  href?: string
}

export type MdBlock =
  | { t: 'p'; src: string }
  | { t: 'h'; level: number; src: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; src: string }
  | { t: 'list'; ordered: boolean; items: { depth: number; src: string }[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' }

// ------------------------------------------------------------------ scanning

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/
const NUMBERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/
const TABLE_ROW = /^ {0,3}\|(.+)\|[ \t]*$/
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/

/** A table cell is only a cell if the row it sits in has a ruler under it. */
function isSeparator(line: string, prev: string): boolean {
  return prev.includes('|') && TABLE_SEP.test(line) && line.includes('-')
}

/** Nesting depth from leading whitespace. Deeper than three reads as noise. */
function indentOf(space: string): number {
  return Math.min(3, Math.floor(space.replace(/\t/g, '  ').length / 2))
}

/** Split one table row on unescaped pipes. */
function cells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '|') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur.trim())
  return out
}

/** Lines that start a block, and therefore end a paragraph. */
function opensBlock(line: string, next: string): boolean {
  return (
    !line.trim() ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    TABLE_ROW.test(line) ||
    isSeparator(line, next)
  )
}

/** Soft breaks become spaces; a trailing double space or backslash is a <br>. */
function joinSoft(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const hard = /(?: {2,}|\\)$/.test(raw)
    const line = raw.replace(/(?: {2,}|\\)$/, '')
    out += out ? (hard ? '\n' : ' ') + line : line
  }
  return out
}

// -------------------------------------------------------------------- block

export function parseMd(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // ---- fence (open fences stay open: that is streaming)
    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1][0]
      const close = new RegExp('^ {0,3}' + (mark === '`' ? '`' : '~') + '{' + fence[1].length + ',}[ \\t]*$')
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      out.push({ t: 'code', lang: fence[2] || '', text: body.join('\n') })
      continue
    }

    // ---- heading
    const head = HEADING.exec(line)
    if (head) {
      out.push({ t: 'h', level: head[1].length, src: head[2].trim() })
      i++
      continue
    }

    // ---- horizontal rule
    if (RULE.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }

    // ---- table
    if (i + 1 < lines.length && isSeparator(lines[i + 1], line)) {
      const head2 = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i]))
        i++
      }
      out.push({ t: 'table', head: head2, rows })
      continue
    }

    // ---- quote
    const quote = QUOTE.exec(line)
    if (quote) {
      const body: string[] = [quote[1]]
      i++
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i])
        if (m) {
          body.push(m[1])
          i++
          continue
        }
        // a lazy continuation line still belongs to the quote
        if (lines[i].trim() && !opensBlock(lines[i], lines[i + 1] ?? '')) {
          body.push(lines[i])
          i++
          continue
        }
        break
      }
      out.push({ t: 'quote', src: joinSoft(body) })
      continue
    }

    // ---- list
    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      const ordered = !!numbered
      const items: { depth: number; src: string }[] = []
      let guard = 0
      while (i < lines.length && guard++ < 5000) {
        const b = BULLET.exec(lines[i])
        const n = NUMBERED.exec(lines[i])
        const hit = ordered ? n : b
        if (hit) {
          items.push({ depth: indentOf(hit[1]), src: hit[hit.length - 1] })
          i++
          continue
        }
        // a wrapped continuation line: keep it with the item it belongs to
        if (lines[i].trim() && items.length && /^\s+\S/.test(lines[i]) && !opensBlock(lines[i], lines[i + 1] ?? '')) {
          const last = items[items.length - 1]
          last.src = joinSoft([last.src, lines[i].trim()])
          i++
          continue
        }
        break
      }
      out.push({ t: 'list', ordered, items })
      continue
    }

    // ---- paragraph (until the next block start)
    const body: string[] = [line]
    i++
    while (i < lines.length && !opensBlock(lines[i], lines[i + 1] ?? '')) {
      body.push(lines[i])
      i++
    }
    out.push({ t: 'p', src: joinSoft(body) })
  }

  return out
}

// ------------------------------------------------------------------- inline

const LINK = /\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/y
const CODE = /`([^`\n]+)`/y
const STRONG = /\*\*([\s\S]+?)\*\*/y
const STRONG_ALT = /__([\s\S]+?)__/y
const DEL = /~~([\s\S]+?)~~/y
const EM = /\*([^*\n]+?)\*/y
const EM_ALT = /_([^_\n]+?)_/y

/** Anything that is not these three schemes is rendered as plain text. */
function safeHref(raw: string): string | undefined {
  return /^(https?:|mailto:)/i.test(raw) ? raw : undefined
}

const WORD = /[\w]/

export function parseInline(src: string): InlineToken[] {
  const out: InlineToken[] = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf })
      buf = ''
    }
  }
  const push = (tok: InlineToken) => {
    flush()
    out.push(tok)
  }
  while (i < src.length) {
    let matched = false
    const c = src[i]

    // links first: their label may contain anything, including emphasis
    if (c === '[') {
      LINK.lastIndex = i
      const m = LINK.exec(src)
      if (m) {
        const href = safeHref(m[2])
        if (href) push({ t: 'link', v: m[1], href })
        else buf += m[0]
        i += m[0].length
        matched = true
      }
    }

    if (!matched && c === '`') {
      CODE.lastIndex = i
      const m = CODE.exec(src)
      if (m) {
        push({ t: 'code', v: m[1] })
        i += m[0].length
        matched = true
      }
    }

    if (!matched && c === '*' && src[i + 1] === '*') {
      STRONG.lastIndex = i
      const m = STRONG.exec(src)
      if (m && m[1].trim()) {
        push({ t: 'strong', v: m[1] })
        i += m[0].length
        matched = true
      }
    }

    if (!matched && c === '_' && src[i + 1] === '_') {
      STRONG_ALT.lastIndex = i
      const m = STRONG_ALT.exec(src)
      if (m && m[1].trim()) {
        push({ t: 'strong', v: m[1] })
        i += m[0].length
        matched = true
      }
    }

    if (!matched && c === '~' && src[i + 1] === '~') {
      DEL.lastIndex = i
      const m = DEL.exec(src)
      if (m && m[1].trim()) {
        push({ t: 'del', v: m[1] })
        i += m[0].length
        matched = true
      }
    }

    if (!matched && c === '*') {
      EM.lastIndex = i
      const m = EM.exec(src)
      if (m && m[1].trim()) {
        push({ t: 'em', v: m[1] })
        i += m[0].length
        matched = true
      }
    }

    // underscore emphasis only at word edges, so session_2_rows stays literal
    if (!matched && c === '_' && !WORD.test(src[i - 1] ?? '')) {
      EM_ALT.lastIndex = i
      const m = EM_ALT.exec(src)
      if (m && m[1].trim() && !WORD.test(src[i + m[0].length] ?? '')) {
        push({ t: 'em', v: m[1] })
        i += m[0].length
        matched = true
      }
    }

    if (!matched) {
      buf += c
      i++
    }
  }

  flush()
  return out
}

/** Everything outside fences, for callers that only want the words. */
export function plainText(src: string): string {
  return parseMd(src)
    .map((b) => {
      switch (b.t) {
        case 'p':
        case 'h':
          return b.src
        case 'code':
          return b.text
        case 'quote':
          return b.src
        case 'list':
          return b.items.map((it) => it.src).join('\n')
        case 'table':
          return [b.head.join(' · '), ...b.rows.map((r) => r.join(' · '))].join('\n')
        default:
          return ''
      }
    })
    .join('\n\n')
}