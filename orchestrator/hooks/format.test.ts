import { expect, test } from 'claude-code/testing'

import type { AgentRequest, AgentStep } from '../types'
import { clean, cleanDetails, parseBrief, parseReport, tokenStats } from './format'

test('parseBrief splits the contract sections, in any case, as plain fields, bold fields or headings', () => {
  const sections = parseBrief('Goal: find it\nContext: a.ts\nmore context\n## task\nread it\n**Done when:** it is found\nRETURN: yes or no')
  expect(sections.map(s => [s.id, s.body])).toEqual([
    ['goal', 'find it'],
    ['context', 'a.ts\nmore context'],
    ['task', 'read it'],
    ['done', 'it is found'],
    ['return', 'yes or no'],
  ])
  expect(sections.map(s => `${s.icon} ${s.title}`)).toEqual(['🎯 Goal', '🧭 Context', '🛠 Task', '✅ Done when', '📦 Return'])
})

test('parseBrief keeps text before the first section as an intro, and a brief with no section as one card', () => {
  expect(parseBrief('Hello.\nGoal: x').map(s => [s.id, s.body])).toEqual([['intro', 'Hello.'], ['goal', 'x']])
  expect(parseBrief('Just do it.\nFast.').map(s => [s.id, s.body])).toEqual([['brief', 'Just do it.\nFast.']])
  expect(parseBrief('')).toEqual([])
})

test('parseBrief does not read a field inside a code fence, or a sentence that opens with the word', () => {
  const sections = parseBrief('Goal: a\n```\nTask: not a section\n```\nReturn the list.\nTasks are done.')
  expect(sections.map(s => s.id)).toEqual(['goal'])
  expect(sections[0]?.body).toContain('Task: not a section')
  expect(sections[0]?.body).toContain('Return the list.')
})

test('parseReport reads the contract fields, and none of them is no report', () => {
  expect(parseReport('STATUS: done\nANSWER: yes')?.status).toBe('done')
  expect(parseReport('It is in a.ts.')).toBeNull()
})

const request = (prompt: number, cacheRead: number, output: number, steps: number): AgentRequest => ({ at: 0, prompt, cacheRead, output, steps })
const call = (n: number, tool: string): AgentStep => ({ n, tool, target: `t${n}`, at: 0, ms: 1, isError: false })

test('tokenStats sums the requests, finds the biggest jumps and the calls between, and the requests over budget', () => {
  const requests = [request(10_000, 0, 100, 0), request(60_000, 40_000, 200, 2), request(61_000, 60_000, 50, 3), request(160_000, 100_000, 400, 3)]
  const stats = tokenStats(requests, [call(1, 'Read'), call(2, 'Grep'), call(3, 'Edit')], 150_000, 2)
  expect(stats).toMatchObject({ count: 4, peak: 160_000, current: 160_000, totalOutput: 750, totalPrompt: 291_000, growth: 50_000, over: [4] })
  expect(Math.round(stats.cacheRate * 1000)).toBe(687)
  expect(stats.jumps.map(j => [j.request, j.delta, j.calls.map(c => c.tool)])).toEqual([[4, 99_000, []], [2, 50_000, ['Read', 'Grep']]])
})

test('tokenStats of no requests, one request, and a shrinking context', () => {
  expect(tokenStats([], [], 150_000)).toMatchObject({ count: 0, peak: 0, current: 0, growth: 0, cacheRate: 0, jumps: [], over: [] })
  expect(tokenStats([request(5_000, 0, 1, 0)], [], 150_000)).toMatchObject({ count: 1, growth: 0, jumps: [] })
  const shrunk = tokenStats([request(90_000, 0, 1, 0), request(30_000, 0, 1, 0)], [], 150_000)
  expect(shrunk).toMatchObject({ peak: 90_000, current: 30_000, growth: -60_000, jumps: [] })
})

test('clean strips escapes and control characters but keeps line breaks and tabs', () => {
  expect(clean('\u001b[31mred\u001b[0m\f\u0000\u0007\u007f\u0085 ok\r\n\tdone')).toBe('red ok\r\n\tdone')
  const kept = cleanDetails({ brief: 'a\u001b[1mb', report: null, steps: [{ n: 1, tool: 'Bash', target: 'x\u0001', at: 0, ms: 1, isError: false, output: '\u001b[2Kgone' }] })
  expect(kept.brief).toBe('ab')
  expect(kept.steps?.[0]).toMatchObject({ target: 'x', output: 'gone' })
})
