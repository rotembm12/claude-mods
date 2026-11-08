import { expect, test } from 'claude-code/testing'

import type { AgentRequest, AgentStep } from '../types'
import { budgetBar, budgetRingSvg, formatTokens, kindOf, PALETTE, sparkline, statusOrbSvg, timelineHeight, timelineSvg, tokenChartSvg } from './visuals'
import type { OrbState } from './visuals'

const LIMIT = 131_072
const NASTY = 'a<b && "c" \'d\' > e'

const request = (i: number): AgentRequest => ({ at: 1000 * i, prompt: 12_000 + i * 700, cacheRead: 9000 + i * 500, output: 200 + ((i * 137) % 900), steps: i })
const TOOLS = ['Read', 'Grep', 'Edit', 'Bash', 'WebFetch', 'TodoWrite']
const step = (n: number, over: Partial<AgentStep> = {}): AgentStep => ({ n, tool: TOOLS[n % TOOLS.length]!, target: `src/file${n}.ts:1-20`, at: n * 3000, ms: 400 + ((n * 523) % 4000), isError: false, ...over })
const requests = (n: number) => Array.from({ length: n }, (_, i) => request(i))
const steps = (n: number) => Array.from({ length: n }, (_, i) => step(i + 1))

// Every opened element is closed, in order: a parser would not choke on it.
function isBalanced(svg: string): boolean {
  const stack: string[] = []
  for (const match of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match
    if (selfClosing) continue
    if (closing) {
      if (stack.pop() !== name) return false
    } else stack.push(name!)
  }
  return stack.length === 0
}

function checkSvg(svg: string) {
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.endsWith('</svg>')).toBe(true)
  expect(/viewBox="0 0 [\d.]+ [\d.]+"/.test(svg)).toBe(true)
  expect(/ width="[\d.]+" height="[\d.]+"/.test(svg)).toBe(true)
  expect(isBalanced(svg)).toBe(true)
  expect(svg.length).toBeLessThan(LIMIT)
  expect(/<script|\son\w+=/.test(svg)).toBe(false)
}

test('tokenChartSvg draws a well-formed chart, animated or not', () => {
  for (const animate of [true, false])
    for (const isRunning of [true, false]) checkSvg(tokenChartSvg(requests(30), steps(30), { width: 640, height: 280, animate, isRunning }))
  const svg = tokenChartSvg(requests(30), steps(30), { width: 640, height: 280, isRunning: true })
  expect(svg).toContain('150K budget')
  expect(svg).toContain('<title>Request 12 ·')
  expect(svg).toContain('after 12 tool calls')
  expect(svg).toContain('repeatCount')
  expect(tokenChartSvg(requests(30), steps(30), { width: 640, height: 280, isRunning: false })).not.toContain('repeatCount')
})

test('tokenChartSvg tooltips carry the delta, cache share and output', () => {
  const svg = tokenChartSvg(requests(3), [], { width: 400, height: 220, animate: false })
  expect(svg).toContain('Request 2 · 12.7K context (+700) · 337 out · 75% cached · after 1 tool call<')
  expect(svg).toContain('Request 1 · 12K context · 200 out')
})

test('tokenChartSvg marks the peak and the zone over the budget', () => {
  const over = requests(20).map((r) => ({ ...r, prompt: r.prompt * 20 }))
  const svg = tokenChartSvg(over, [], { width: 600, height: 260, animate: false })
  expect(svg).toContain('Peak 5')
  expect(svg).toContain('clip-path')
  expect(tokenChartSvg(requests(5), [], { width: 600, height: 260, animate: false })).not.toContain('clip-path')
  expect(tokenChartSvg(requests(5), [], { width: 600, height: 260, budget: 20_000, animate: false })).toContain('20K budget')
})

test('tokenChartSvg shows nothing hidden when not animated', () => {
  const svg = tokenChartSvg(requests(30), steps(30), { width: 640, height: 280, animate: false })
  expect(svg).not.toContain('animation')
  expect(svg).not.toContain('class="pop"')
  expect(svg).not.toContain('stroke-dasharray:1')
})

test('tokenChartSvg renders placeholders for none and one request', () => {
  const none = tokenChartSvg([], [], { width: 480, height: 240 })
  checkSvg(none)
  expect(none).toContain('Waiting for the first request')
  const one = tokenChartSvg([request(0)], [], { width: 480, height: 240 })
  checkSvg(one)
  expect(one).toContain('First request in')
})

test('tokenChartSvg stays under the size limit with 200 requests', () => {
  const svg = tokenChartSvg(requests(200), steps(80), { width: 900, height: 320, isRunning: true })
  checkSvg(svg)
  expect((svg.match(/<title>Request/g) ?? []).length).toBeLessThanOrEqual(160)
  expect(svg).toContain('Request 200 ·')
})

test('tokenChartSvg colors the strip by the kind of tool calls between requests', () => {
  const reqs: AgentRequest[] = [
    { at: 0, prompt: 10_000, cacheRead: 0, output: 50, steps: 0 },
    { at: 1, prompt: 20_000, cacheRead: 5000, output: 50, steps: 2 },
  ]
  const svg = tokenChartSvg(reqs, [step(1, { tool: 'Read' }), step(2, { tool: 'Edit' })], { width: 400, height: 220, animate: false })
  expect(svg).toContain(`fill="${PALETTE.explore}" fill-opacity="0.92"`)
  expect(svg).toContain(`fill="${PALETTE.edit}" fill-opacity="0.92"`)
  expect(svg).toContain('>explore</text>')
  expect(svg).not.toContain('>research</text>')
})

test('timelineSvg draws a lane per kind present and a bar per step', () => {
  const list = steps(25)
  const svg = timelineSvg(list, { width: 640, height: timelineHeight(list), totalMs: 90_000, animate: false })
  checkSvg(svg)
  expect((svg.match(/class="st"/g) ?? []).length).toBe(25)
  for (const kind of ['explore', 'research', 'edit', 'run', 'other']) expect(svg).toContain(`>${kind}</text>`)
  expect(svg).toContain('<title>#7 ')
  expect(svg).toContain('0:00')
  expect(svg).not.toContain('animation')
})

test('timelineSvg tooltip names the call, when it started and how long it took', () => {
  const svg = timelineSvg([step(7, { tool: 'Read', target: 'src/auth.ts:10-30', at: 42_000, ms: 1200 })], { width: 400, height: 100, animate: false })
  expect(svg).toContain('<title>#7 Read src/auth.ts:10-30 · 0:42 · 1.2s</title>')
})

test('timelineSvg marks failures and running calls', () => {
  const list = [step(1, { isError: true }), step(2, { tool: 'Bash', ms: null, at: 30_000 })]
  const svg = timelineSvg(list, { width: 480, height: 120, totalMs: 60_000, isRunning: true })
  checkSvg(svg)
  expect(svg).toContain('✗')
  expect(svg).toContain(PALETTE.error)
  expect(svg).toContain('now')
  expect(svg).toContain('· running</title>')
  expect(svg).toContain('repeatCount')
  expect(timelineSvg(list, { width: 480, height: 120, totalMs: 60_000, isRunning: false })).not.toContain('>now<')
})

test('timelineSvg renders a placeholder with no steps and survives 80 steps', () => {
  const none = timelineSvg([], { width: 480, height: 100 })
  checkSvg(none)
  expect(none).toContain('No tool calls yet')
  const many = timelineSvg(steps(80), { width: 800, height: 200, totalMs: 300_000 })
  checkSvg(many)
  expect(timelineHeight(steps(80))).toBeGreaterThan(timelineHeight([step(1, { tool: 'Read' })]))
})

test('text from the transcript is escaped in every visual', () => {
  const list = [step(1, { target: NASTY, tool: 'Ba<sh' })]
  const svg = timelineSvg(list, { width: 400, height: 100, animate: false })
  checkSvg(svg)
  expect(svg).toContain('a&lt;b &amp;&amp; &quot;c&quot; &#39;d&#39; &gt; e')
  expect(svg).not.toContain('a<b')
  expect(svg).not.toContain('Ba<sh')
  const chart = tokenChartSvg(requests(3), list, { width: 400, height: 220, budget: 150_000 })
  checkSvg(chart)
})

test('control characters in a target never reach the SVG', () => {
  const svg = timelineSvg([step(1, { target: 'echo hi\u0000\u001b[0m\nnext' })], { width: 400, height: 100 })
  expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)).toBe(false)
  checkSvg(svg)
})

test('budgetRingSvg shows the peak, the budget and a color by fill level', () => {
  const low = budgetRingSvg(48_000, 150_000, { size: 120 })
  checkSvg(low)
  expect(low).toContain('>48K</text>')
  expect(low).toContain('>of 150K</text>')
  expect(low).toContain(PALETTE.good)
  expect(budgetRingSvg(130_000, 150_000, { size: 120 })).toContain(PALETTE.warn)
  const over = budgetRingSvg(180_000, 150_000, { size: 120, animate: false })
  expect(over).toContain(PALETTE.bad)
  expect(over).not.toContain('animation')
  checkSvg(budgetRingSvg(0, 150_000, { size: 120 }))
  checkSvg(budgetRingSvg(10, 0, { size: 60 }))
})

test('statusOrbSvg draws every state', () => {
  const states: OrbState[] = ['running', 'done', 'partial', 'blocked', 'failed', 'killed']
  const seen = new Set<string>()
  for (const state of states) {
    const svg = statusOrbSvg(state, { size: 18 })
    checkSvg(svg)
    expect(svg).toContain(`Agent ${state}`)
    seen.add(svg)
  }
  expect(seen.size).toBe(states.length)
  expect(statusOrbSvg('running')).toContain('animateTransform')
  expect(statusOrbSvg('running', { animate: false })).not.toContain('animate')
})

test('kindOf groups tools as the pane does', () => {
  expect(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].map(kindOf)).toEqual(Array(5).fill('explore'))
  expect(['WebFetch', 'WebSearch'].map(kindOf)).toEqual(['research', 'research'])
  expect(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map(kindOf)).toEqual(Array(4).fill('edit'))
  expect(['Bash', 'PowerShell'].map(kindOf)).toEqual(['run', 'run'])
  expect(kindOf('TodoWrite')).toBe('other')
})

test('sparkline is as wide as asked and rises with the values', () => {
  for (const width of [1, 8, 20, 40]) expect(sparkline([1, 5, 2, 9, 4, 7, 3, 8, 6, 10, 2, 1], width).length).toBe(width)
  expect(sparkline([], 6)).toBe('▁▁▁▁▁▁')
  expect(sparkline([0, 0, 0], 3)).toBe('▁▁▁')
  const rising = sparkline([10, 20, 30, 40, 50, 60, 70, 80], 8)
  expect([...rising].sort().join('')).toBe(rising)
  expect(rising.endsWith('█')).toBe(true)
  expect(sparkline(Array.from({ length: 500 }, (_, i) => i), 10).length).toBe(10)
})

test('formatTokens abbreviates thousands and millions', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(812)).toBe('812')
  expect(formatTokens(1000)).toBe('1K')
  expect(formatTokens(48_200)).toBe('48.2K')
  expect(formatTokens(150_000)).toBe('150K')
  expect(formatTokens(999_960)).toBe('1M')
  expect(formatTokens(1_200_000)).toBe('1.2M')
  expect(formatTokens(-3100)).toBe('-3.1K')
})

test('budgetBar fills in proportion and caps at the width', () => {
  expect(budgetBar(48_000, 150_000, 12)).toBe('████░░░░░░░░ 32%')
  expect(budgetBar(0, 150_000, 10)).toBe('░░░░░░░░░░ 0%')
  expect(budgetBar(150_000, 150_000, 10)).toBe('██████████ 100%')
  expect(budgetBar(300_000, 150_000, 10)).toBe('██████████ 200%')
  expect(budgetBar(10, 150_000, 10)).toBe('█░░░░░░░░░ 0%')
})
