// What the band and the details pane both say about an agent, and the pure text work the
// pane does: a report split by the contract's fields, a brief split into its sections, the
// phases of a run's steps, and what the model requests say about how its context grew.
import type { AgentDetails, AgentRequest, AgentRun, AgentStep } from '../types'
import { kindOf } from './visuals'
import type { Kind } from './visuals'

export const ROLE_PREFIX = 'orchestrator:'

// Text with no terminal escape and no control character but the line break, the tab
// and the carriage return: a drawn string that holds one is refused with its whole tree.
export const clean = (text: string): string =>
  text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')

// An agent's details with every string clean: for details an earlier version stored.
export function cleanDetails(d: AgentDetails): AgentDetails {
  return {
    ...d,
    brief: clean(d.brief),
    report: d.report === null ? null : clean(d.report),
    ...(d.steps !== undefined
      ? {
          steps: d.steps.map(s => ({
            ...s,
            tool: clean(s.tool),
            target: clean(s.target),
            ...(s.path !== undefined ? { path: clean(s.path) } : {}),
            ...(s.input !== undefined ? { input: clean(s.input) } : {}),
            ...(s.output !== undefined ? { output: clean(s.output) } : {}),
          })),
        }
      : {}),
  }
}

export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// A step's start, as minutes and seconds after the agent's.
export function clockOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const GLYPHS: Record<AgentRun['status'], [string, string]> = {
  running: ['●', 'warning'],
  completed: ['✓', 'success'],
  failed: ['✗', 'error'],
  killed: ['■', 'inactive'],
}

export const labelOf = (run: AgentRun) => run.name ?? run.description
export const typeOf = (run: AgentRun) => (run.type.startsWith(ROLE_PREFIX) ? run.type.slice(ROLE_PREFIX.length) : run.type)
export const stateOf = (run: AgentRun) =>
  run.status === 'running' ? 'running' : run.status === 'completed' ? (run.outcome ?? 'done') : run.status
export const timeOf = (run: AgentRun, now: number) => duration(run.runMs + (run.status === 'running' ? now - run.since : 0))
export const toolsOf = (run: AgentRun) => `${run.tools} ${run.tools === 1 ? 'tool' : 'tools'}`

// "claude-haiku-5-5" as "Haiku 5.5"; a model id of another shape shows its tier.
export function modelName(model: string | undefined, tier: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model ?? '')
  const name = match?.[1] ?? tier
  const pretty = name.charAt(0).toUpperCase() + name.slice(1)
  return match?.[2] !== undefined ? `${pretty} ${match[2]}.${match[3]}` : pretty
}

// ---------------------------------------------------------------------------
// The report

// A report split by the contract's fields; null when it follows none of them.
export type Report = { status?: string; answer?: string; evidence?: string; changes?: string; open?: string; notes: string }
const FIELD = /^\s*(?:[-*>#]+\s*)?\**(STATUS|ANSWER|EVIDENCE|CHANGES|OPEN)\**\s*:\**\s*/
// The first word of a status, lowercase, with the markdown and the punctuation around it gone.
const wordOf = (text: string) => /^[^A-Za-z]*([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase()
// The STATUS a report opens with, as a field in any of the forms FIELD reads.
export function statusOf(report: string): string | undefined {
  for (const line of report.split('\n')) {
    const match = FIELD.exec(line)
    if (match?.[1] === 'STATUS') return wordOf(line.slice(match[0].length))
  }
  return undefined
}
export function parseReport(report: string): Report | null {
  const fields: Record<string, string[]> = {}
  const notes: string[] = []
  let current: string | null = null
  for (const line of report.split('\n')) {
    const match = FIELD.exec(line)
    if (match?.[1] !== undefined) {
      current = match[1].toLowerCase()
      fields[current] = [line.slice(match[0].length)]
    } else if (current !== null) fields[current]?.push(line)
    else notes.push(line)
  }
  if (fields.status === undefined && fields.answer === undefined) return null
  const field = (name: string) => {
    const text = fields[name]?.join('\n').trim()
    return text === undefined || text === '' ? undefined : text
  }
  return {
    status: wordOf(field('status') ?? ''),
    answer: field('answer'),
    evidence: field('evidence'),
    changes: field('changes'),
    open: field('open'),
    notes: notes.join('\n').trim(),
  }
}

// path:line references read as code, where the line has none of its own.
export function codeRefs(line: string): string {
  if (line.includes('`')) return line
  return line.replace(/(^|[\s(])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)(?=[\s),;]|\.(?:\s|$)|$)/g, '$1`$2`')
}

// The items of a report field: one per line, or per "; " when the agent wrote them on one line.
export function itemsOf(body: string): string[] {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l !== '')
  return lines.length === 1 && (lines[0] ?? '').includes('; ') ? (lines[0] ?? '').split(/;\s+/) : lines
}

// One line of a report field, or its lines as a list.
export function listify(body: string): string {
  const items = itemsOf(body)
  if (items.length === 1) return codeRefs(items[0] ?? '')
  return items.map(item => (/^([-*]|\d+[.)])\s/.test(item) ? codeRefs(item) : `- ${codeRefs(item.replace(/^•\s*/, ''))}`)).join('\n')
}

// Markdown joins a paragraph's lines: keep each line of plain text on its own.
export const hardBreaks = (text: string) => text.replace(/([^\n])\n(?=[^\n])/g, '$1  \n')

// ---------------------------------------------------------------------------
// The brief

export type BriefSection = { id: 'intro' | 'goal' | 'context' | 'task' | 'done' | 'return' | 'brief'; title: string; icon: string; body: string }
const BRIEF_FIELDS: Record<string, BriefSection['id']> = { goal: 'goal', context: 'context', task: 'task', 'done when': 'done', return: 'return' }
export const BRIEF_TITLES: Record<BriefSection['id'], [string, string]> = {
  intro: ['Intro', '📄'],
  goal: ['Goal', '🎯'],
  context: ['Context', '🧭'],
  task: ['Task', '🛠'],
  done: ['Done when', '✅'],
  return: ['Return', '📦'],
  brief: ['Brief', '📄'],
}
// A section opens on a line "Goal: ...", "**Goal:** ...", or a markdown heading "## Goal".
const BRIEF_HEAD = /^\s*#{1,6}\s+\**(goal|context|task|done when|return)\**\s*:?\**\s*$/i
const BRIEF_COLON = /^\s*(?:#{1,6}\s+)?\**(goal|context|task|done when|return)\s*:\**\s*(.*)$/i

// The brief by its sections, in order; text before the first one is an intro, and a brief
// with no section at all is one card holding the whole of it.
export function parseBrief(brief: string): BriefSection[] {
  const sections: BriefSection[] = []
  const intro: string[] = []
  let current: { id: BriefSection['id']; lines: string[] } | null = null
  let inFence = false
  const flush = () => {
    if (current !== null) sections.push({ id: current.id, title: BRIEF_TITLES[current.id][0], icon: BRIEF_TITLES[current.id][1], body: current.lines.join('\n').trim() })
  }
  for (const line of brief.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const match = inFence ? null : (BRIEF_COLON.exec(line) ?? BRIEF_HEAD.exec(line))
    const id = match?.[1] !== undefined ? BRIEF_FIELDS[match[1].toLowerCase()] : undefined
    if (id !== undefined) {
      flush()
      current = { id, lines: [match?.[2] ?? ''] }
    } else if (current !== null) current.lines.push(line)
    else intro.push(line)
  }
  flush()
  const text = intro.join('\n').trim()
  if (sections.length === 0) return text === '' ? [] : [{ id: 'brief', title: BRIEF_TITLES.brief[0], icon: BRIEF_TITLES.brief[1], body: text }]
  return text === '' ? sections : [{ id: 'intro', title: BRIEF_TITLES.intro[0], icon: BRIEF_TITLES.intro[1], body: text }, ...sections]
}

// ---------------------------------------------------------------------------
// The steps as a story

export type Phase = { kind: Kind; steps: AgentStep[] }
export function phasesOf(steps: AgentStep[]): Phase[] {
  const phases: Phase[] = []
  for (const step of steps) {
    const kind = kindOf(step.tool)
    const last = phases.at(-1)
    if (last !== undefined && last.kind === kind) last.steps.push(step)
    else phases.push({ kind, steps: [step] })
  }
  return phases
}
const PHASE_LABELS: Record<Kind, string> = { explore: 'Explored', research: 'Researched', edit: 'Edited', run: 'Ran commands', other: '' }
export const phaseLabel = (phase: Phase) =>
  phase.kind === 'other' ? `Used ${[...new Set(phase.steps.map(s => s.tool))].join(', ')}` : PHASE_LABELS[phase.kind]
// ① to ⑳, then plain numbers.
export const marker = (n: number) => (n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n))

// Cells for each tool in a bar of `cells`: in proportion to its count, one at least.
export function barCells(counts: number[], cells: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const sizes = counts.map(n => Math.max(1, Math.round((n / total) * cells)))
  const widest = () => sizes.indexOf(Math.max(...sizes))
  while (sizes.reduce((a, b) => a + b, 0) > cells && Math.max(...sizes) > 1) sizes[widest()]!--
  while (sizes.reduce((a, b) => a + b, 0) < cells) sizes[widest()]!++
  return sizes
}
// Tools that share a color take turns at these, so they stay apart.
export const FILLS = ['█', '▓', '▒', '░']
export const SWATCHES = ['■', '▓', '▒', '░']

// ---------------------------------------------------------------------------
// The tokens

// One request that grew the context much: its number (from 1), by how much, and the calls
// the agent made between it and the request before.
export type Jump = { request: number; delta: number; prompt: number; calls: AgentStep[] }
export type TokenStats = {
  count: number
  peak: number
  current: number
  totalOutput: number
  totalPrompt: number
  // Of the prompt processed, the share the cache served, 0 to 1.
  cacheRate: number
  // How much the context grew per request on average, from the first request to the last.
  growth: number
  jumps: Jump[]
  // The numbers (from 1) of the requests past the budget.
  over: number[]
}

export function tokenStats(requests: readonly AgentRequest[], steps: readonly AgentStep[], budget: number, jumps = 3): TokenStats {
  const count = requests.length
  const totalPrompt = requests.reduce((a, r) => a + r.prompt, 0)
  const cached = requests.reduce((a, r) => a + r.cacheRead, 0)
  const growth = count > 1 ? ((requests[count - 1]?.prompt ?? 0) - (requests[0]?.prompt ?? 0)) / (count - 1) : 0
  const all: Jump[] = []
  for (let i = 1; i < count; i++) {
    const prev = requests[i - 1] as AgentRequest
    const r = requests[i] as AgentRequest
    const delta = r.prompt - prev.prompt
    if (delta > 0) all.push({ request: i + 1, delta, prompt: r.prompt, calls: steps.filter(s => s.n > prev.steps && s.n <= r.steps) })
  }
  return {
    count,
    peak: requests.reduce((a, r) => Math.max(a, r.prompt), 0),
    current: requests[count - 1]?.prompt ?? 0,
    totalOutput: requests.reduce((a, r) => a + r.output, 0),
    totalPrompt,
    cacheRate: totalPrompt > 0 ? cached / totalPrompt : 0,
    growth,
    jumps: all.sort((a, b) => b.delta - a.delta || a.request - b.request).slice(0, jumps),
    over: requests.flatMap((r, i) => (r.prompt > budget ? [i + 1] : [])),
  }
}
