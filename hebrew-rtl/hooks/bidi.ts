// Visual order for terminals that paint every cell left to right and do no
// bidi of their own (xterm.js in VS Code and Cursor, Windows Terminal).
// A reduced Unicode Bidirectional Algorithm (UAX #9): one paragraph level,
// no explicit embeddings or isolates, no bracket pairing (N0).

export type Style = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  dim?: boolean
}

export type Span = { text: string; style: Style }

/** One drawn line, its spans already in visual order. */
export type Row = { align: 'left' | 'right'; spans: Span[] }

/** Lines with no right-to-left text go to the engine's own renderer. */
export type Piece = { kind: 'markdown'; text: string } | { kind: 'rows'; rows: Row[] }

/** Hebrew, Arabic and their presentation forms, and the RLM mark. */
export const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿‏]/

type Kind = 'L' | 'R' | 'EN' | 'ES' | 'ET' | 'CS' | 'WS' | 'ON'

type Unit = { text: string; style: Style; kind: Kind; isAtom: boolean; level: number }

// A base character and the marks on it (niqqud, cantillation) move as one.
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu
const MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
  '<': '>', '>': '<', '«': '»', '»': '«',
}
const OPENERS = '([{<«"\'“‘'
const CLOSERS = '.,:;!?)]}>»"\'”’'
const STYLE_KEYS = ['bold', 'italic', 'underline', 'strike', 'code', 'dim'] as const
const WIDE = /\p{Emoji_Presentation}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u
const ZERO_WIDTH = /^[​-‏⁠︎️]+$/

function kindOf(cluster: string): Kind {
  const ch = String.fromCodePoint(cluster.codePointAt(0) ?? 32)
  if (RTL.test(ch)) return 'R'
  if (/[0-9]/.test(ch)) return 'EN'
  if (ch === '+' || ch === '-' || ch === '−') return 'ES'
  if (/[#$%°¢£¥₪€‰]/.test(ch)) return 'ET'
  if (/[,.\/: ]/.test(ch)) return 'CS'
  if (/\s/.test(ch)) return 'WS'
  if (/[\p{L}\p{Mc}‎]/u.test(ch)) return 'L'
  return 'ON'
}

const sameStyle = (a: Style, b: Style) => STYLE_KEYS.every(key => !a[key] === !b[key])

/** Joins neighbours of one style and drops empty spans. */
export function merge(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const span of spans) {
    if (span.text === '') continue
    const last = out[out.length - 1]
    if (last && sameStyle(last.style, span.style)) {
      out[out.length - 1] = { text: last.text + span.text, style: last.style }
    } else {
      out.push(span)
    }
  }
  return out
}

/** The terminal cells a text takes. */
export function cellWidth(text: string): number {
  let width = 0
  for (const c of text.match(CLUSTER) ?? []) {
    width += ZERO_WIDTH.test(c) ? 0 : WIDE.test(c) ? 2 : 1
  }
  return width
}

// A Latin word with its symbols (`--help`, `src/App.tsx`, a URL) is one
// strong left-to-right unit, so its inner order never flips. Punctuation at
// its edges stays outside, so a comma after it lands on the reading side.
function unitsOf(spans: Span[]): Unit[] {
  const out: Unit[] = []
  const push = (text: string, style: Style, kind: Kind, isAtom: boolean) => {
    if (text !== '') out.push({ text, style, kind, isAtom, level: 0 })
  }
  const clusters = (text: string, style: Style) => {
    for (const c of text.match(CLUSTER) ?? []) push(c, style, kindOf(c), false)
  }
  for (const { text, style } of spans) {
    if (style.code && !RTL.test(text)) {
      push(text, style, 'L', true)
      continue
    }
    for (const word of text.split(/(\s+)/)) {
      if (RTL.test(word) || !/\p{L}/u.test(word)) {
        clusters(word, style)
        continue
      }
      let start = 0
      let end = word.length
      while (start < end && OPENERS.includes(word[start] ?? '')) start++
      while (end > start && CLOSERS.includes(word[end - 1] ?? '')) end--
      const core = word.slice(start, end)
      if (!/\p{L}/u.test(core)) {
        clusters(word, style)
        continue
      }
      clusters(word.slice(0, start), style)
      push(core, style, 'L', true)
      clusters(word.slice(end), style)
    }
  }
  return out
}

// Rules W4 to W7, N1 and N2, I1 and I2, and L1 of UAX #9.
function resolveLevels(units: Unit[], rtl: boolean): void {
  const e: 'L' | 'R' = rtl ? 'R' : 'L'
  const k = units.map(u => u.kind)
  const n = k.length

  for (let i = 1; i < n - 1; i++) {
    if ((k[i] === 'ES' || k[i] === 'CS') && k[i - 1] === 'EN' && k[i + 1] === 'EN') k[i] = 'EN'
  }
  for (let i = 0; i < n; i++) {
    if (k[i] !== 'ET') continue
    let j = i
    while (j < n && k[j] === 'ET') j++
    if (k[i - 1] === 'EN' || k[j] === 'EN') k.fill('EN', i, j)
    i = j
  }
  for (let i = 0; i < n; i++) {
    if (k[i] === 'ES' || k[i] === 'ET' || k[i] === 'CS') k[i] = 'ON'
  }
  let strong: Kind = e
  for (let i = 0; i < n; i++) {
    const kind = k[i]
    if (kind === 'L' || kind === 'R') strong = kind
    else if (kind === 'EN' && strong === 'L') k[i] = 'L'
  }

  // A number counts as right-to-left for the neutrals beside it.
  const side = (kind: Kind | undefined): 'L' | 'R' => (kind === undefined ? e : kind === 'L' ? 'L' : 'R')
  for (let i = 0; i < n; i++) {
    if (k[i] !== 'WS' && k[i] !== 'ON') continue
    let j = i
    while (j < n && (k[j] === 'WS' || k[j] === 'ON')) j++
    const before = side(k[i - 1])
    const after = side(k[j])
    k.fill(before === after ? before : e, i, j)
    i = j
  }

  units.forEach((u, i) => {
    const kind = k[i]
    u.level = kind === 'R' ? 1 : kind === 'EN' || rtl ? 2 : 0
  })
  const base = rtl ? 1 : 0
  for (let i = n - 1; i >= 0 && units[i]?.kind === 'WS'; i--) {
    const unit = units[i]
    if (unit) unit.level = base
  }
}

// Rule L2: from the highest level down to 1, reverse every run at or above it.
function reorder(units: Unit[]): Unit[] {
  const out = units.slice()
  const max = out.reduce((m, u) => Math.max(m, u.level), 0)
  for (let level = max; level >= 1; level--) {
    for (let i = 0; i < out.length; i++) {
      if ((out[i]?.level ?? 0) < level) continue
      let j = i
      while (j < out.length && (out[j]?.level ?? 0) >= level) j++
      out.splice(i, j - i, ...out.slice(i, j).reverse())
      i = j
    }
  }
  return out
}

/** One line's spans, logical order in, the order a terminal paints out. */
export function visual(spans: Span[], rtl: boolean): Span[] {
  const units = unitsOf(spans)
  resolveLevels(units, rtl)
  return merge(
    reorder(units).map(u => ({
      text: u.level % 2 === 1 ? (MIRROR[u.text] ?? u.text) : u.text,
      style: u.style,
    })),
  )
}

/** `visual` for plain text. */
export function visualText(text: string, rtl: boolean): string {
  return visual([{ text, style: {} }], rtl)
    .map(s => s.text)
    .join('')
}

/**
 * Whether a line reads right to left: its first strong letter is Hebrew, or
 * Hebrew letters outnumber Latin ones. Inline code is not counted.
 */
export function isRtl(spans: Span[]): boolean {
  let rtl = 0
  let ltr = 0
  let first: 'L' | 'R' | undefined
  for (const span of spans) {
    if (span.style.code) continue
    for (const ch of span.text) {
      if (RTL.test(ch)) {
        rtl++
        first ??= 'R'
      } else if (/\p{L}/u.test(ch)) {
        ltr++
        first ??= 'L'
      }
    }
  }
  return first === 'R' || (rtl > 0 && rtl >= ltr)
}

type Token = { isGap: boolean; spans: Span[]; width: number }

function tokensOf(spans: Span[]): Token[] {
  const tokens: Token[] = []
  for (const { text, style } of spans) {
    for (const part of text.split(/(\s+)/)) {
      if (part === '') continue
      const isGap = /^\s/.test(part)
      const last = tokens[tokens.length - 1]
      const width = cellWidth(part)
      if (last && last.isGap === isGap) {
        last.spans.push({ text: part, style })
        last.width += width
      } else {
        tokens.push({ isGap, spans: [{ text: part, style }], width })
      }
    }
  }
  return tokens
}

/** Breaks a line at spaces so that no piece is wider than `width` cells. */
export function wrap(spans: Span[], width: number): Span[][] {
  const lines: Span[][] = []
  let line: Span[] = []
  let used = 0
  let gap: Token | undefined
  const flush = () => {
    lines.push(merge(line))
    line = []
    used = 0
  }
  for (const token of tokensOf(spans)) {
    if (token.isGap) {
      gap = token
      continue
    }
    if (used > 0) {
      const gapWidth = gap?.width ?? 0
      if (used + gapWidth + token.width > width) {
        flush()
      } else if (gap) {
        line.push(...gap.spans)
        used += gapWidth
      }
    }
    gap = undefined
    if (token.width <= width - used) {
      line.push(...token.spans)
      used += token.width
      continue
    }
    // A word wider than the line is cut between clusters.
    for (const { text, style } of token.spans) {
      for (const c of text.match(CLUSTER) ?? []) {
        const w = cellWidth(c)
        if (used > 0 && used + w > width) flush()
        line.push({ text: c, style })
        used += w
      }
    }
  }
  if (line.length > 0 || lines.length === 0) flush()
  return lines
}

const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?![\s*])(.+?)(?<![\s*])\*|(?<![\p{L}\p{N}_])_(?![\s_])(.+?)(?<![\s_])_(?![\p{L}\p{N}_])|\[([^\]]+)\]\(([^)\s]+)\)/gu

/** The inline markdown of one line, as styled spans. */
export function parseInline(text: string, style: Style = {}): Span[] {
  const out: Span[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), style })
    const [, code, bold, boldAlt, strike, italic, italicAlt, label, href] = m
    if (code !== undefined) {
      out.push({ text: code, style: { ...style, code: true } })
    } else if (bold !== undefined || boldAlt !== undefined) {
      out.push(...parseInline(bold ?? boldAlt ?? '', { ...style, bold: true }))
    } else if (strike !== undefined) {
      out.push(...parseInline(strike, { ...style, strike: true }))
    } else if (italic !== undefined || italicAlt !== undefined) {
      out.push(...parseInline(italic ?? italicAlt ?? '', { ...style, italic: true }))
    } else if (label !== undefined) {
      out.push(...parseInline(label, { ...style, underline: true }))
      if (href !== undefined && href !== label) {
        out.push({ text: ` (${href})`, style: { ...style, dim: true } })
      }
    }
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), style })
  return merge(out)
}

const EMPTY_ROW: Row = { align: 'left', spans: [] }

// A paragraph, heading or list item: wrapped in logical order first, then
// each line reordered, so the first words stay on the first line.
function block(spans: Span[], width: number, lead = '', leadStyle: Style = {}): Row[] {
  const rtl = isRtl(spans)
  const leadWidth = cellWidth(lead)
  const room = Math.max(8, width - leadWidth)
  return wrap(spans, room).map((line, i) => {
    const mark = i === 0 ? lead : ' '.repeat(leadWidth)
    const markSpan = { text: rtl ? visualText(mark, true) : mark, style: leadStyle }
    const body = visual(line, rtl)
    return rtl
      ? { align: 'right', spans: merge([...body, markSpan]) }
      : { align: 'left', spans: merge([markSpan, ...body]) }
  })
}

const HEADING = /^\s*#{1,6}\s+(.*)$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

function rowsOf(line: string, width: number): Row[] {
  const heading = HEADING.exec(line)
  if (heading) return block(parseInline(heading[1] ?? '', { bold: true }), width)
  const item = ITEM.exec(line)
  if (item) {
    const marker = /\d/.test(item[2] ?? '') ? (item[2] ?? '') : '•'
    return block(parseInline(item[3] ?? ''), width, `${item[1] ?? ''}${marker} `)
  }
  const quote = QUOTE.exec(line)
  if (quote) return block(parseInline(quote[1] ?? '', { italic: true }), width, '▎ ', { dim: true })
  return block(parseInline(line.trim()), width)
}

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
const isDelimiterRow = (cells: string[]) => cells.every(c => /^\s*:?-+:?\s*$/.test(c))

// Emphasis markers must touch the text, so spaces go outside them.
function toMarkdown(spans: Span[]): string {
  return spans
    .map(({ text, style }) => {
      const [, before = '', core = '', after = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? []
      if (core === '') return text
      let out = style.code ? `\`${core}\`` : core
      if (style.italic) out = `*${out}*`
      if (style.bold) out = `**${out}**`
      if (style.strike) out = `~~${out}~~`
      return before + out + after
    })
    .join('')
}

// A Hebrew table reads from the right: its columns are reversed, each cell
// reordered and aligned to the right.
function rtlTable(lines: string[]): string {
  const rows = lines.map(cellsOf)
  const rtl = isRtl(rows.flat().flatMap(c => parseInline(c.trim())))
  return rows
    .map(cells => {
      const drawn = isDelimiterRow(cells)
        ? cells.map(c => {
            const cell = c.trim()
            if (!rtl || (cell.startsWith(':') && cell.endsWith(':'))) return cell
            return cell.endsWith(':') ? `:${cell.slice(0, -1)}` : `${cell.replace(/^:/, '')}:`
          })
        : cells.map(c => {
            const spans = parseInline(c.trim())
            return RTL.test(c) ? toMarkdown(visual(spans, isRtl(spans))) : c.trim()
          })
      return `| ${(rtl ? drawn.reverse() : drawn).join(' | ')} |`
    })
    .join('\n')
}

const FENCE = /^\s*(`{3,}|~{3,})/
const TABLE = /^\s*\|/

/**
 * A reply's markdown as pieces: runs of lines with no right-to-left text are
 * left to the engine's renderer, the rest drawn as rows `width` cells wide.
 */
export function layout(markdown: string, width: number): Piece[] {
  const lines = markdown.split('\n')
  const pieces: Piece[] = []
  let isAfterBlank = false

  const addMarkdown = (text: string) => {
    const last = pieces[pieces.length - 1]
    if (last?.kind === 'markdown') {
      last.text += (isAfterBlank ? '\n\n' : '\n') + text
    } else {
      if (isAfterBlank && last) last.rows.push(EMPTY_ROW)
      pieces.push({ kind: 'markdown', text })
    }
    isAfterBlank = false
  }
  const addRows = (rows: Row[]) => {
    const last = pieces[pieces.length - 1]
    const lead = isAfterBlank && last ? [EMPTY_ROW] : []
    if (last?.kind === 'rows') last.rows.push(...lead, ...rows)
    else pieces.push({ kind: 'rows', rows: [...lead, ...rows] })
    isAfterBlank = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)?.[1]
    if (fence) {
      // Code keeps its left-to-right lines; only Hebrew inside them flips.
      let j = i + 1
      while (j < lines.length && !(lines[j] ?? '').trim().startsWith(fence)) j++
      const body = lines.slice(i + 1, j).map(l => (RTL.test(l) ? visualText(l, false) : l))
      addMarkdown([line, ...body, ...(j < lines.length ? [lines[j] ?? ''] : [])].join('\n'))
      i = j
    } else if (TABLE.test(line)) {
      let j = i
      while (j < lines.length && TABLE.test(lines[j] ?? '')) j++
      const table = lines.slice(i, j)
      addMarkdown(table.some(l => RTL.test(l)) ? rtlTable(table) : table.join('\n'))
      i = j - 1
    } else if (line.trim() === '') {
      isAfterBlank = pieces.length > 0
    } else if (RTL.test(line)) {
      addRows(rowsOf(line, width))
    } else {
      addMarkdown(line)
    }
  }
  return pieces
}

/** Plain text (a prompt), each Hebrew line wrapped and reordered. */
export function plainVisual(text: string, width: number): string {
  return text
    .split('\n')
    .map(line => {
      if (!RTL.test(line)) return line
      const spans = [{ text: line, style: {} }]
      const rtl = isRtl(spans)
      return wrap(spans, width)
        .map(l => visual(l, rtl).map(s => s.text).join(''))
        .join('\n')
    })
    .join('\n')
}
