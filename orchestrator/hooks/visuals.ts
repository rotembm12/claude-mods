// Visuals for the agent details pane: pure functions that return SVG source (for the
// desktop `Svg` element, drawn as an image so the pane keeps the scroll wheel; the
// :hover styles and <title> tips only show where a surface draws it interactive) and
// plain-text twins for the terminal.
//
//   tokenChartSvg(requests, steps, opts)  context growth per request: area chart, budget line,
//                                         peak marker, output bars, a strip colored by tool kind
//   timelineSvg(steps, opts)              one swimlane per tool kind, a bar per call over time
//   timelineHeight(steps, rowH?)          a height that fits timelineSvg's lanes
//   budgetMeterSvg(peak, budget, opts)    a slim bar of peak context against the budget
//   mixBarSvg(segments, opts)             one bar split by each tool's share of the calls
//   statusOrbSvg(state, opts)             a small glyph for an agent's state
//   sparkline(values, width)              ▁▂▃▄▅▆▇█, resampled to exactly `width` cells
//   formatTokens(n)                       "812", "48.2K", "1.2M"
//   budgetBar(peak, budget, cells)        "████████░░░░ 32%"
//   kindOf(tool), PALETTE, KIND_LABELS    how tools group, and the colors every visual shares
//
// Rules every SVG follows: transparent background (the pane's theme is unknown, so colors
// are mid-tone and read on light and dark alike); width, height and viewBox always set; all
// text escaped; at most MAX_POINTS points; with `animate: false` everything is drawn in its
// final state, and with animation the keyframes only name the *starting* state, so a frame
// that ignores them (or a reader who prefers reduced motion) still shows the finished picture.
import type { AgentRequest, AgentStep } from '../types'

export type Kind = 'explore' | 'research' | 'edit' | 'run' | 'other'
export type OrbState = 'running' | 'done' | 'partial' | 'blocked' | 'failed' | 'killed'

export const PALETTE = {
  explore: '#60a5fa',
  research: '#a78bfa',
  edit: '#34d399',
  run: '#fbbf24',
  other: '#f472b6',
  error: '#f87171',
  muted: '#9ca3af',
  // Text on an unknown background: a mid-tone that holds on white and on #1e1e1e.
  label: '#8b93a1',
  output: '#22d3ee',
  // Fill levels of the context budget.
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  now: '#38bdf8',
} as const

export const KINDS: readonly Kind[] = ['explore', 'research', 'edit', 'run', 'other']
export const KIND_LABELS: Record<Kind, string> = { explore: 'explore', research: 'research', edit: 'edit', run: 'run', other: 'other' }

const FIND_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const RUN_TOOLS = new Set(['Bash', 'PowerShell'])

export const kindOf = (tool: string): Kind =>
  FIND_TOOLS.has(tool) ? 'explore' : WEB_TOOLS.has(tool) ? 'research' : EDIT_TOOLS.has(tool) ? 'edit' : RUN_TOOLS.has(tool) ? 'run' : 'other'

const MAX_POINTS = 160
// The one color of the context line and its fill; red takes over past the budget.
const ACCENT = '#38bdf8'
const FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif'

// ---------------------------------------------------------------------------
// Text helpers

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const v = Math.abs(Math.round(n))
  const sign = n < 0 ? '-' : ''
  if (v < 1000) return `${sign}${v}`
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '')
  const k = trim(v / 1000)
  if (parseFloat(k) < 1000) return `${sign}${k}K`
  return `${sign}${trim(v / 1_000_000)}M`
}

const BLOCKS = '▁▂▃▄▅▆▇█'

export function sparkline(values: number[], width: number): string {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return ''
  const clean = values.filter(Number.isFinite)
  if (clean.length === 0) return BLOCKS[0]!.repeat(w)
  // Bucket-average when there are more values than cells, stretch by index when fewer.
  const cells: number[] = []
  for (let c = 0; c < w; c++) {
    const from = Math.floor((c * clean.length) / w)
    const to = Math.max(from + 1, Math.floor(((c + 1) * clean.length) / w))
    let sum = 0
    for (let i = from; i < to; i++) sum += clean[i]!
    cells.push(sum / (to - from))
  }
  const hi = Math.max(...cells)
  const lo = Math.min(0, ...cells)
  if (hi <= lo) return BLOCKS[0]!.repeat(w)
  return cells.map((v) => BLOCKS[Math.min(7, Math.max(0, Math.round(((v - lo) / (hi - lo)) * 7)))]).join('')
}

export function budgetBar(peak: number, budget: number, cells: number): string {
  const c = Math.max(1, Math.floor(cells))
  const frac = budget > 0 ? Math.max(0, peak) / budget : 0
  const filled = Math.min(c, Math.max(peak > 0 ? 1 : 0, Math.round(frac * c)))
  return `${'█'.repeat(filled)}${'░'.repeat(c - filled)} ${Math.round(frac * 100)}%`
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// ---------------------------------------------------------------------------
// SVG helpers

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
// Text from a transcript: no control characters (invalid in XML), one line, clipped.
const esc = (s: string, max = 160): string => {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  return clipped.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

const r1 = (x: number): string => String(Math.round(x * 10) / 10)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const levelColor = (frac: number): string => (frac >= 1 ? PALETTE.bad : frac >= 0.75 ? PALETTE.warn : PALETTE.good)
const textW = (s: string, px: number): number => s.length * px * 0.58

function svgOpen(width: number, height: number, label: string, box = `0 0 ${width} ${height}`): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box}" font-family='${FONT}' role="img" aria-label="${esc(label)}">`
}

// Monotone cubic through the points: smooth, and never overshoots a data point.
function smoothPath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M${r1(pts[0]![0])} ${r1(pts[0]![1])}`
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0])
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1))
  }
  const t: number[] = [m[0]!]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2)
  t.push(m[n - 2]!)
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i]! / m[i]!
    const b = t[i + 1]! / m[i]!
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      t[i] = tau * a * m[i]!
      t[i + 1] = tau * b * m[i]!
    }
  }
  let d = `M${r1(pts[0]![0])} ${r1(pts[0]![1])}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3
    d += `C${r1(pts[i]![0] + h)} ${r1(pts[i]![1] + t[i]! * h)} ${r1(pts[i + 1]![0] - h)} ${r1(pts[i + 1]![1] - t[i + 1]! * h)} ${r1(pts[i + 1]![0])} ${r1(pts[i + 1]![1])}`
  }
  return d
}

// At most `max` indices of 0..n-1: the first and last always, and the tallest of each bucket between.
function pickIndices(values: readonly number[], max: number): number[] {
  const n = values.length
  if (n <= max) return values.map((_, i) => i)
  const out = [0]
  const inner = n - 2
  const buckets = max - 2
  for (let b = 0; b < buckets; b++) {
    const from = 1 + Math.floor((b * inner) / buckets)
    const to = 1 + Math.floor(((b + 1) * inner) / buckets)
    let best = from
    for (let i = from; i < to; i++) if (values[i]! > values[best]!) best = i
    out.push(best)
  }
  out.push(n - 1)
  return out
}

const TICK_STEPS = [1e3, 2e3, 5e3, 1e4, 2e4, 2.5e4, 5e4, 1e5, 2e5, 2.5e5, 5e5, 1e6, 2e6, 5e6]

// ---------------------------------------------------------------------------
// Token chart

export type TokenChartOpts = { width: number; height: number; budget?: number; isRunning?: boolean; animate?: boolean }

function requestTip(index: number, r: AgentRequest, prev: AgentRequest | undefined): string {
  const delta = prev ? ` (${r.prompt >= prev.prompt ? '+' : '-'}${formatTokens(Math.abs(r.prompt - prev.prompt))})` : ''
  const parts = [`Request ${index + 1}`, `${formatTokens(r.prompt)} context${delta}`, `${formatTokens(r.output)} out`]
  if (r.prompt > 0) parts.push(`${Math.round((r.cacheRead / r.prompt) * 100)}% cached`)
  parts.push(r.steps === 0 ? 'before any tool calls' : `after ${r.steps} tool call${r.steps === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function tokenChartSvg(requests: readonly AgentRequest[], steps: readonly AgentStep[], opts: TokenChartOpts): string {
  const W = Math.max(200, Math.round(opts.width))
  const H = Math.max(140, Math.round(opts.height))
  const budget = opts.budget ?? 150_000
  const animate = opts.animate ?? true
  const running = opts.isRunning === true
  const id = 'tc'
  const label = requests.length === 0 ? 'Context per request: no requests yet' : `Context per request: ${requests.length} requests, peak ${formatTokens(Math.max(...requests.map((r) => r.prompt)))} of ${formatTokens(budget)}`

  // Layout: header, plot, output bars, tool strip, request ticks.
  const padL = 42
  const padR = 14
  const top = 26
  const tickRowY = H - 4
  const stripH = 7
  const stripY = H - 28
  const outH = 22
  const outBase = stripY - 4
  const bottom = outBase - outH - 8
  const plotH = Math.max(40, bottom - top)
  const plotL = padL + 10
  const plotR = W - padR - 10

  const peakAll = requests.reduce((a, r) => Math.max(a, r.prompt), 0)
  const yMax = Math.max(budget * 1.1, peakAll * 1.12)
  const y = (v: number): number => bottom - (clamp(v, 0, yMax) / yMax) * plotH
  const yB = y(budget)

  // The kept points (≤ MAX_POINTS) and what they stand for.
  const idx = pickIndices(requests.map((r) => r.prompt), MAX_POINTS)
  const m = idx.length
  const xs = idx.map((_, k) => (m === 1 ? (plotL + plotR) / 2 : plotL + ((plotR - plotL) * k) / (m - 1)))
  const step = m > 1 ? (plotR - plotL) / (m - 1) : plotR - plotL
  const pts = idx.map((i, k) => [xs[k]!, y(requests[i]!.prompt)] as const)

  const out: string[] = []
  const defs: string[] = []
  const cls = (name: string, delay?: number): string => (animate ? ` class="${name}"${delay !== undefined ? ` style="animation-delay:${Math.round(delay * 1000)}ms"` : ''}` : '')

  // Grid and y axis
  const target = clamp(Math.floor(plotH / 38), 2, 5)
  const tickStep = TICK_STEPS.find((s) => yMax / s <= target) ?? 5e6
  for (let v = 0; v <= yMax; v += tickStep) {
    const ty = y(v)
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${r1(ty)}" y2="${r1(ty)}" stroke="${PALETTE.muted}" stroke-opacity="${v === 0 ? 0.35 : 0.12}" stroke-width="1"/>`)
    if (v === 0 || Math.abs(ty - yB) > 9) out.push(`<text x="${padL - 6}" y="${r1(ty + 3.5)}" font-size="10" text-anchor="end" fill="${PALETTE.label}">${formatTokens(v)}</text>`)
  }

  // Over-budget zone, and the budget line.
  const over = peakAll > budget
  out.push(`<rect x="${padL}" y="${r1(top)}" width="${W - padL - padR}" height="${r1(Math.max(0, yB - top))}" fill="${PALETTE.bad}" fill-opacity="${over ? 0.06 : 0.03}"/>`)

  if (requests.length === 0) {
    // Placeholder: a ghost of the curve to come, and a line saying so.
    const gx = (t: number): number => plotL + (plotR - plotL) * t
    const ghost = smoothPath([0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => [gx(t), y(budget * (0.04 + 0.46 * t * t))] as const))
    out.push(`<path d="${ghost}" fill="none" stroke="${PALETTE.muted}" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round"/>`)
    out.push(`<text x="${r1((plotL + plotR) / 2)}" y="${r1((yB + y(budget * 0.667)) / 2 - 8)}" font-size="13" font-weight="600" text-anchor="middle" fill="${PALETTE.label}">Waiting for the first request</text>`)
    out.push(`<text x="${r1((plotL + plotR) / 2)}" y="${r1((yB + y(budget * 0.667)) / 2 + 8)}" font-size="10.5" text-anchor="middle" fill="${PALETTE.label}" fill-opacity="0.8">Context growth draws here as the agent works</text>`)
  } else {
    // One accent: a soft fill under the line, fading to nothing at the base. What lies past
    // the budget is drawn again in red, clipped to the zone above the budget line.
    defs.push(`<linearGradient id="${id}-f" gradientUnits="userSpaceOnUse" x1="0" y1="${r1(y(peakAll))}" x2="0" y2="${r1(bottom)}"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.3"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0.02"/></linearGradient>`)
    defs.push(`<clipPath id="${id}-o"><rect x="${padL}" y="${r1(top - 8)}" width="${W - padL - padR}" height="${r1(Math.max(0, yB - top + 8))}"/></clipPath>`)
    const line = smoothPath(pts)
    const base = r1(bottom)
    if (m > 1) {
      defs.push(`<path id="${id}-a" d="${line}L${r1(xs[m - 1]!)} ${base}L${r1(xs[0]!)} ${base}Z"/>`)
      defs.push(`<path id="${id}-l" d="${line}" fill="none" pathLength="1"/>`)
      out.push(`<g${cls('fd')}>`)
      out.push(`<use href="#${id}-a" fill="url(#${id}-f)"/>`)
      if (over) out.push(`<use href="#${id}-a" fill="${PALETTE.bad}" fill-opacity="0.14" clip-path="url(#${id}-o)"/>`)
      out.push('</g>')
    }
  }

  // Budget line and its label.
  const budgetText = `${formatTokens(budget)} budget`
  // The label sits at the left, unless the peak is there too.
  const peakK = idx.reduce((b, i, k) => (requests[i]!.prompt > requests[idx[b]!]!.prompt ? k : b), 0)
  const hitsLeft = requests.length > 0 && xs[peakK]! < plotL + 110
  const isOver = peakAll > budget
  out.push(`<line x1="${padL}" x2="${W - padR}" y1="${r1(yB)}" y2="${r1(yB)}" stroke="${PALETTE.bad}" stroke-opacity="0.75" stroke-width="1" stroke-dasharray="4 4"/>`)
  out.push(`<text x="${hitsLeft ? W - padR - 2 : padL + 4}" y="${r1(isOver ? yB + 13 : yB - 5)}" font-size="10" font-weight="600" text-anchor="${hitsLeft ? 'end' : 'start'}" fill="${PALETTE.bad}">${esc(budgetText)}</text>`)

  if (requests.length > 0) {
    // Output bars and tool strip under the plot.
    const maxOut = Math.max(1, ...idx.map((i) => requests[i]!.output))
    const barW = clamp(step * 0.5, 1.5, 9)
    const byN = new Map<number, AgentStep>()
    for (const s of steps) byN.set(s.n, s)
    const seen = new Set<Kind>()

    out.push(`<text x="${padL - 6}" y="${r1(outBase - 2)}" font-size="9" text-anchor="end" fill="${PALETTE.label}">out</text>`)
    out.push(`<text x="${padL - 6}" y="${r1(stripY + 6)}" font-size="9" text-anchor="end" fill="${PALETTE.label}">tools</text>`)
    out.push(`<text x="${padL - 6}" y="${tickRowY}" font-size="9" text-anchor="end" fill="${PALETTE.label}">req</text>`)

    const bars: string[] = []
    const strip: string[] = []
    const cols: string[] = []
    const dots: string[] = []
    const dotR = m <= 24 ? 3 : 2.2
    const showDots = m <= 40
    const popStep = Math.min(0.035, 0.9 / m)
    idx.forEach((i, k) => {
      const r = requests[i]!
      const x = xs[k]!
      const h = Math.max(1.5, (r.output / maxOut) * outH)
      bars.push(`<rect${cls('gr', 0.15 + k * popStep * 0.6)} x="${r1(x - barW / 2)}" y="${r1(outBase - h)}" width="${r1(barW)}" height="${r1(h)}" rx="${r1(Math.min(2, barW / 2))}" fill="${PALETTE.output}" fill-opacity="0.55"/>`)

      if (k > 0) {
        const prevI = idx[k - 1]!
        const from = requests[prevI]!.steps
        const counts = new Map<Kind | 'unknown', number>()
        let known = 0
        for (let n = from + 1; n <= r.steps; n++) {
          const s = byN.get(n)
          if (!s) continue
          const kd = kindOf(s.tool)
          counts.set(kd, (counts.get(kd) ?? 0) + 1)
          known++
          seen.add(kd)
        }
        const total = Math.max(0, r.steps - from)
        if (total > known) counts.set('unknown', total - known)
        const x0 = xs[k - 1]! + 0.7
        const w = Math.max(1, xs[k]! - xs[k - 1]! - 1.4)
        if (total === 0) strip.push(`<rect x="${r1(x0)}" y="${stripY}" width="${r1(w)}" height="${stripH}" rx="2" fill="${PALETTE.muted}" fill-opacity="0.2"/>`)
        else {
          let cx = x0
          const order = [...KINDS, 'unknown' as const]
          for (const kd of order) {
            const c = counts.get(kd)
            if (!c) continue
            const bw = (w * c) / total
            strip.push(`<rect x="${r1(cx)}" y="${stripY}" width="${r1(Math.max(0.6, bw - (bw > 3 ? 0.6 : 0)))}" height="${stripH}" rx="${bw > 5 ? 2 : 0.8}" fill="${kd === 'unknown' ? PALETTE.muted : PALETTE[kd]}" fill-opacity="${kd === 'unknown' ? 0.4 : 0.92}"/>`)
            cx += bw
          }
        }
      }

      const color = r.prompt > budget ? PALETTE.bad : ACCENT
      const tip = esc(requestTip(i, r, i > 0 ? requests[i - 1] : undefined))
      const colW = Math.max(2, step)
      cols.push(`<g class="pt"><title>${tip}</title><rect class="col" x="${r1(x - colW / 2)}" y="${r1(top)}" width="${r1(colW)}" height="${r1(stripY + stripH - top)}" fill="${PALETTE.muted}" fill-opacity="0"/></g>`)
      if (showDots) dots.push(`<circle${cls('pop', 0.9 + k * popStep)} cx="${r1(x)}" cy="${r1(pts[k]![1])}" r="${dotR}" fill="${color}" pointer-events="none"/>`)
    })

    out.push(...bars, ...strip)
    if (m > 1) {
      out.push(`<use href="#${id}-l" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${cls('dl')}/>`)
      if (over) out.push(`<use href="#${id}-l" stroke="${PALETTE.bad}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#${id}-o)"${cls('dl')}/>`)
    }
    out.push(...dots)

    // Peak marker
    const pk = peakK
    const [px, py] = pts[pk]!
    const peakColor = requests[idx[pk]!]!.prompt > budget ? PALETTE.bad : ACCENT
    const peakText = `${m === 1 ? '' : 'Peak '}${formatTokens(requests[idx[pk]!]!.prompt)}`
    const pw = textW(peakText, 10) + 16
    const above = py - 26 >= top - 4
    const lx = clamp(above ? px - pw / 2 : px - pw - 9, padL, W - padR - pw)
    const ly = above ? py - 24 : py - 9
    out.push(`<g${cls('fd', 1.5)}>`)
    out.push(`<circle cx="${r1(px)}" cy="${r1(py)}" r="4" fill="${peakColor}"/><circle cx="${r1(px)}" cy="${r1(py)}" r="7.5" fill="none" stroke="${peakColor}" stroke-opacity="0.45" stroke-width="1.5"/>`)
    out.push(`<rect x="${r1(lx)}" y="${r1(ly)}" width="${r1(pw)}" height="17" rx="8.5" fill="${peakColor}"/>`)
    out.push(`<text x="${r1(lx + pw / 2)}" y="${r1(ly + 12)}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">${esc(peakText)}</text>`)
    out.push('</g>')

    if (m === 1) out.push(`<text x="${r1((plotL + plotR) / 2)}" y="${r1((yB + y(budget * 0.667)) / 2 + 4)}" font-size="10.5" text-anchor="middle" fill="${PALETTE.label}" fill-opacity="0.85">First request in. The chart grows with each one.</text>`)

    // The last point: a pulse while the agent runs.
    if (running) {
      const [lx2, ly2] = pts[m - 1]!
      const c = requests[idx[m - 1]!]!.prompt > budget ? PALETTE.bad : ACCENT
      out.push(
        animate
          ? `<circle cx="${r1(lx2)}" cy="${r1(ly2)}" r="5" fill="none" stroke="${c}" stroke-width="1.6"><animate attributeName="r" values="4;13" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0" dur="1.6s" repeatCount="indefinite"/></circle>`
          : `<circle cx="${r1(lx2)}" cy="${r1(ly2)}" r="8" fill="none" stroke="${c}" stroke-width="1.4" stroke-opacity="0.45"/>`,
      )
    }

    // Request ticks
    const tickCount = clamp(Math.floor((plotR - plotL) / 64), 2, 7)
    const tickAt = new Set<number>()
    for (let t = 0; t < Math.min(tickCount, m); t++) tickAt.add(m === 1 ? 0 : Math.round((t * (m - 1)) / (Math.min(tickCount, m) - 1 || 1)))
    for (const k of tickAt) out.push(`<text x="${r1(xs[k]!)}" y="${tickRowY}" font-size="10" text-anchor="middle" fill="${PALETTE.label}">${idx[k]! + 1}</text>`)

    out.push(...cols)

    // Legend: the tool kinds on the strip.
    const kinds = KINDS.filter((k) => seen.has(k))
    let lxr = W - padR
    for (const kd of [...kinds].reverse()) {
      const name = KIND_LABELS[kd]
      const w = textW(name, 10) + 16
      lxr -= w
      out.push(`<circle cx="${r1(lxr + 4)}" cy="10" r="3.5" fill="${PALETTE[kd]}"/><text x="${r1(lxr + 11)}" y="14" font-size="10" fill="${PALETTE.label}">${name}</text>`)
    }
  }

  const style = [
    '.pt:hover .col{fill-opacity:.16}',
    animate
      ? `.dl{stroke-dasharray:1;animation:tc-draw 1.3s cubic-bezier(.4,0,.2,1) both}.fd{animation:tc-fade .9s ease-out 1s both}.pop{transform-box:fill-box;transform-origin:center;animation:tc-pop .4s cubic-bezier(.34,1.56,.64,1) both}.gr{transform-box:fill-box;transform-origin:50% 100%;animation:tc-grow .5s cubic-bezier(.2,.8,.2,1) both}` +
        '@keyframes tc-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}@keyframes tc-fade{from{opacity:0}to{opacity:1}}@keyframes tc-pop{from{opacity:0;transform:scale(0)}to{opacity:1;transform:scale(1)}}@keyframes tc-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}' +
        '@media (prefers-reduced-motion:reduce){.dl,.fd,.pop,.gr{animation:none}}'
      : '',
  ].join('')

  return `${svgOpen(W, H, label)}<title>${esc(label)}</title><style>${style}</style><defs>${defs.join('')}</defs>${out.join('')}</svg>`
}

// ---------------------------------------------------------------------------
// Timeline

export type TimelineOpts = { width: number; height: number; totalMs?: number; isRunning?: boolean; animate?: boolean }

const TL_TOP = 20
const TL_BOTTOM = 22

// A height that fits one comfortable row per kind present.
export function timelineHeight(steps: readonly AgentStep[], rowH = 26): number {
  const lanes = Math.max(1, new Set(steps.map((s) => kindOf(s.tool))).size)
  return TL_TOP + lanes * rowH + TL_BOTTOM
}

function stepTip(s: AgentStep): string {
  const parts = [`#${s.n} ${s.tool}${s.target ? ` ${s.target}` : ''}`, clock(s.at), s.ms === null ? 'running' : duration(s.ms)]
  if (s.isError) parts.push('failed')
  return parts.join(' · ')
}

export function timelineSvg(steps: readonly AgentStep[], opts: TimelineOpts): string {
  const W = Math.max(240, Math.round(opts.width))
  const H = Math.max(80, Math.round(opts.height))
  const animate = opts.animate ?? true
  const running = opts.isRunning === true
  const id = 'tl'
  const label = steps.length === 0 ? 'Timeline: no tool calls yet' : `Timeline of ${steps.length} tool calls`

  const padL = 86
  const padR = 22
  const plotL = padL
  const plotR = W - padR
  const plotW = plotR - plotL
  const laneTop = TL_TOP
  const laneBottom = H - TL_BOTTOM

  const lastEnd = steps.reduce((a, s) => Math.max(a, s.at + (s.ms ?? 0)), 0)
  const total = Math.max(1000, opts.totalMs ?? 0, lastEnd)
  const px = (ms: number): number => plotL + (clamp(ms, 0, total) / total) * plotW

  const out: string[] = []
  const defs: string[] = []
  const cls = (name: string, delay?: number): string => (animate ? ` class="${name}"${delay !== undefined ? ` style="animation-delay:${Math.round(delay * 1000)}ms"` : ''}` : '')

  // Time axis
  const S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
  const want = Math.max(2, Math.floor(plotW / 78))
  const tickS = S.find((s) => total / 1000 / s <= want) ?? 7200
  const axisY = laneBottom + 4
  out.push(`<line x1="${plotL}" x2="${plotR}" y1="${axisY}" y2="${axisY}" stroke="${PALETTE.muted}" stroke-opacity="0.3"/>`)
  for (let t = 0; t * 1000 <= total; t += tickS) {
    const x = px(t * 1000)
    out.push(`<line x1="${r1(x)}" x2="${r1(x)}" y1="${laneTop - 4}" y2="${axisY + 3}" stroke="${PALETTE.muted}" stroke-opacity="${t === 0 ? 0.25 : 0.1}"/>`)
    out.push(`<text x="${r1(x)}" y="${axisY + 14}" font-size="10" text-anchor="${t === 0 ? 'start' : 'middle'}" fill="${PALETTE.label}">${clock(t * 1000)}</text>`)
  }

  if (steps.length === 0) {
    out.push(`<text x="${r1((plotL + plotR) / 2)}" y="${r1((laneTop + laneBottom) / 2 + 4)}" font-size="12" font-weight="600" text-anchor="middle" fill="${PALETTE.label}">No tool calls yet</text>`)
    return `${svgOpen(W, H, label)}<title>${esc(label)}</title>${out.join('')}</svg>`
  }

  const kinds = KINDS.filter((k) => steps.some((s) => kindOf(s.tool) === k))
  const laneH = clamp((laneBottom - laneTop) / kinds.length, 16, 44)
  let order = 0
  const style: string[] = ['.st:hover rect{stroke:#9ca3af;stroke-width:1.5}']

  kinds.forEach((kd, li) => {
    const ly = laneTop + li * laneH
    const color = PALETTE[kd]
    const mine = steps.filter((s) => kindOf(s.tool) === kd).sort((a, b) => a.at - b.at)
    out.push(`<rect x="4" y="${r1(ly + 1)}" width="${W - 8}" height="${r1(laneH - 2)}" rx="8" fill="${PALETTE.muted}" fill-opacity="0.07"/>`)
    out.push(`<circle cx="17" cy="${r1(ly + laneH / 2)}" r="4" fill="${color}"/>`)
    out.push(`<text x="27" y="${r1(ly + laneH / 2 + 3.8)}" font-size="11" fill="${PALETTE.label}">${KIND_LABELS[kd]}</text>`)
    out.push(`<text x="${padL - 8}" y="${r1(ly + laneH / 2 + 3.5)}" font-size="9.5" text-anchor="end" fill="${PALETTE.label}" fill-opacity="0.75">${mine.length}</text>`)

    // Overlapping calls share the lane in sub-rows.
    const rowEnds: number[] = []
    const placed = mine.map((s) => {
      const x0 = px(s.at)
      const x1 = Math.max(x0 + 4, s.ms === null ? plotR : px(s.at + s.ms))
      let row = rowEnds.findIndex((e) => e + 1 <= x0)
      if (row < 0) row = rowEnds.length < 3 ? rowEnds.length : rowEnds.indexOf(Math.min(...rowEnds))
      rowEnds[row] = x1
      return { s, x0, x1, row }
    })
    const rows = Math.max(1, rowEnds.length)
    const subH = (laneH - 6) / rows
    placed.forEach(({ s, x0, x1, row }) => {
      // Slim pills, centred in their row: a lane reads as a track, not a block.
      const bh = clamp(subH - (rows > 1 ? 2 : 0), 4, 10)
      const by = ly + 3 + row * subH + (subH - bh) / 2
      const w = x1 - x0
      const rx = Math.min(bh / 2, w / 2)
      const delay = order * Math.min(0.04, 1.2 / steps.length)
      order++
      const failed = s.isError
      const isLive = s.ms === null
      const fill = `fill="${color}" fill-opacity="${failed ? 0.5 : isLive ? 0.85 : 0.92}"`
      const edge = failed ? ` stroke="${PALETTE.error}" stroke-width="1.6"` : ''
      let g = `<g class="st"><title>${esc(stepTip(s))}</title>`
      g += `<rect${cls('gx', delay)} x="${r1(x0)}" y="${r1(by)}" width="${r1(w)}" height="${r1(bh)}" rx="${r1(rx)}" ${fill}${edge}/>`
      if (isLive && animate && w > 12) {
        const cid = `${id}-c${s.n}`
        defs.push(`<clipPath id="${cid}"><rect x="${r1(x0)}" y="${r1(by)}" width="${r1(w)}" height="${r1(bh)}" rx="${r1(rx)}"/></clipPath>`)
        g += `<rect x="${r1(x0 - 36)}" y="${r1(by)}" width="36" height="${r1(bh)}" fill="url(#${id}-sh)" clip-path="url(#${cid})"><animate attributeName="x" from="${r1(x0 - 36)}" to="${r1(x1)}" dur="1.6s" repeatCount="indefinite"/></rect>`
      }
      if (failed) {
        const room = plotR - x1 > 14
        g += `<text x="${r1(room ? x1 + 3 : x0 - 3)}" y="${r1(by + bh / 2 + 3.6)}" font-size="10.5" font-weight="700" text-anchor="${room ? 'start' : 'end'}" fill="${PALETTE.error}">✗</text>`
      }
      out.push(`${g}</g>`)
    })
  })

  defs.push(`<linearGradient id="${id}-sh" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`)

  if (running) {
    const x = plotR
    out.push(`<line x1="${x}" x2="${x}" y1="${laneTop - 4}" y2="${axisY}" stroke="${PALETTE.now}" stroke-width="1.5" stroke-opacity="0.9"/>`)
    out.push(`<circle cx="${x}" cy="${laneTop - 8}" r="3.5" fill="${PALETTE.now}">${animate ? '<animate attributeName="r" values="3;5.5;3" dur="1.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.45;1" dur="1.5s" repeatCount="indefinite"/>' : ''}</circle>`)
    out.push(`<text x="${x - 8}" y="${laneTop - 5}" font-size="9.5" font-weight="600" text-anchor="end" fill="${PALETTE.now}">now</text>`)
  }

  if (animate) {
    style.push('.gx{transform-box:fill-box;transform-origin:0 50%;animation:tl-grow .5s cubic-bezier(.2,.8,.2,1) both}@keyframes tl-grow{from{transform:scaleX(0);opacity:0}to{transform:scaleX(1);opacity:1}}@media (prefers-reduced-motion:reduce){.gx{animation:none}}')
  }

  return `${svgOpen(W, H, label)}<title>${esc(label)}</title><style>${style.join('')}</style><defs>${defs.join('')}</defs>${out.join('')}</svg>`
}

// ---------------------------------------------------------------------------
// Budget meter

export type MeterOpts = { width: number; animate?: boolean }

// A slim bar of peak context against the budget. Past the budget the track
// stretches to the peak and a tick marks where the budget ends.
export function budgetMeterSvg(peak: number, budget: number, opts: MeterOpts): string {
  const W = Math.max(40, Math.round(opts.width))
  const H = 10
  const animate = opts.animate ?? true
  const frac = budget > 0 ? Math.max(0, peak) / budget : 0
  const color = levelColor(frac)
  const scale = Math.max(budget, peak, 1)
  const fill = clamp((Math.max(0, peak) / scale) * W, peak > 0 ? 4 : 0, W)
  const tick = (budget / scale) * W
  const label = `Peak context ${formatTokens(peak)} of ${formatTokens(budget)} (${Math.round(frac * 100)}%)`
  const parts = [
    `<rect x="0" y="2" width="${W}" height="6" rx="3" fill="${PALETTE.muted}" fill-opacity="0.22"/>`,
    fill > 0 ? `<rect${animate ? ' class="grow"' : ''} x="0" y="2" width="${r1(fill)}" height="6" rx="3" fill="${color}"/>` : '',
    frac > 1 ? `<rect x="${r1(clamp(tick - 1, 0, W - 2))}" y="0" width="2" height="${H}" rx="1" fill="${PALETTE.label}"/>` : '',
  ]
  const style = animate
    ? '.grow{transform-box:fill-box;transform-origin:0 50%;animation:bm-grow .9s cubic-bezier(.3,.7,.2,1) both}@keyframes bm-grow{from{transform:scaleX(0)}}@media (prefers-reduced-motion:reduce){.grow{animation:none}}'
    : ''
  return `${svgOpen(W, H, label)}<title>${esc(label)}</title><style>${style}</style>${parts.join('')}</svg>`
}

// ---------------------------------------------------------------------------
// Tool mix bar

// `shade` tells apart tools that share a color: 0 full, 1 lighter, 2 lighter still.
export type MixSegment = { name: string; count: number; color: string; shade?: number }

// One rounded bar split by share, a hairline gap between segments.
export function mixBarSvg(segments: readonly MixSegment[], opts: { width: number }): string {
  const W = Math.max(40, Math.round(opts.width))
  const H = 8
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.count), 0)
  const label = `Tool mix: ${segments.map((s) => `${s.name} ${s.count}`).join(', ')}`
  const rects: string[] = []
  let x = 0
  for (const s of segments) {
    if (total === 0 || s.count <= 0) continue
    const w = (s.count / total) * W
    rects.push(`<rect x="${r1(x)}" y="0" width="${r1(Math.max(1, w - 2))}" height="${H}" fill="${s.color}" fill-opacity="${[1, 0.6, 0.35][s.shade ?? 0] ?? 1}"><title>${esc(`${s.name} ${s.count}`)}</title></rect>`)
    x += w
  }
  return `${svgOpen(W, H, label)}<title>${esc(label)}</title><defs><clipPath id="mx"><rect width="${W}" height="${H}" rx="4"/></clipPath></defs><g clip-path="url(#mx)">${rects.join('')}</g></svg>`
}

// ---------------------------------------------------------------------------
// Status orb

export type OrbOpts = { size?: number; animate?: boolean }

export const ORB_COLORS: Record<OrbState, string> = {
  running: PALETTE.now,
  done: PALETTE.good,
  partial: PALETTE.warn,
  blocked: '#fb923c',
  failed: PALETTE.bad,
  killed: PALETTE.muted,
}

export function statusOrbSvg(state: OrbState, opts: OrbOpts = {}): string {
  const size = Math.max(10, Math.round(opts.size ?? 18))
  const animate = opts.animate ?? true
  const color = ORB_COLORS[state] ?? PALETTE.muted
  const white = 'fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"'
  const solid = `<circle cx="12" cy="12" r="11" fill="${color}"/>`
  let body: string
  switch (state) {
    case 'running':
      body =
        `<circle cx="12" cy="12" r="9.5" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.3" stroke-width="2"/>` +
        `<circle cx="12" cy="12" r="9.5" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" pathLength="100" stroke-dasharray="28 72">${animate ? '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.1s" repeatCount="indefinite"/>' : ''}</circle>` +
        `<circle cx="12" cy="12" r="3.4" fill="${color}">${animate ? '<animate attributeName="r" values="2.4;4;2.4" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.55;1" dur="1.4s" repeatCount="indefinite"/>' : ''}</circle>`
      break
    case 'done':
      body = `${solid}<path d="M7 12.4l3.4 3.4L17.2 8.6" pathLength="1" ${white}${animate ? ' stroke-dasharray="1"' : ''}>${animate ? '<animate attributeName="stroke-dashoffset" from="1" to="0" dur="0.5s" fill="freeze"/>' : ''}</path>`
      break
    case 'partial':
      body = `<circle cx="12" cy="12" r="9.8" fill="none" stroke="${color}" stroke-width="2.2"/><path d="M12 5.6a6.4 6.4 0 0 1 0 12.8z" fill="${color}"/>`
      break
    case 'blocked':
      body = `${solid}<path d="M9.2 7.6v8.8M14.8 7.6v8.8" ${white}/>`
      break
    case 'failed':
      body = `${solid}<path d="M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" ${white}/>`
      break
    default:
      body = `${solid}<rect x="8.2" y="8.2" width="7.6" height="7.6" rx="1.6" fill="#fff"/>`
  }
  const label = `Agent ${state}`
  return `${svgOpen(size, size, label, '0 0 24 24')}<title>${esc(label)}</title>${body}</svg>`
}
