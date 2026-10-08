import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import { ROLES } from './prompts'

const SURFACES = ['terminal', 'desktop'] as const
const PLUGIN = 'orchestrator'
const BASE = { id: 'intro', text: 'You are Claude Code.', scope: 'shared' } as const
const ENGINE = { plugin: 'engine', tier: 'core' } as const

const band = (hasSurvey = false, bodyColumns = 80, maxRows = 10) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
  }) as const

type Setup = { store?: Record<string, unknown>; models?: Record<string, string> }

// Stand in for the engine beneath the plugin, and keep what reached it.
function engine(on: On, setup: Setup = {}) {
  const store: Record<string, unknown> = { ...setup.store }
  const clock = mock.clock(on)
  const seen = { store, clock, prompts: [] as { text: string; context?: readonly string[] }[], spawned: [] as AgentSpawnInput[], roles: [] as string[], commands: [] as string[] }
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('agent.register', (_$, e) => {
    seen.roles.push(e.name)
    return { value: { agent: `orchestrator:${e.name}` } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('prompt.compose', () => ({ sections: [BASE] }))
  on('prompt.submit', (_$, e) => {
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(e)
    return { model: setup.models?.[e.subagentType] ?? e.model ?? 'claude-opus-5-5', agentId: `agent-${seen.spawned.length}` }
  })
  on('tool.call', (_$, e) => ({ result: {} as never, text: e.tool === 'Read' ? 'x'.repeat(e.file_path === 'big.ts' ? 12_000 : 200) : 'ok' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return seen
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'orchestrator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

const compose = async ($: Engine, traits: ('teammate' | 'print')[] = []) =>
  (
    await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools: [],
      outputStyle: null,
      traits,
    })
  ).sections.map(s => s.id)

const offered = async ($: Engine, agent: string) =>
  (await $.agent.offer({ agent, description: 'a type', source: agent.includes(':') ? 'plugin' : 'built-in', provider: ENGINE })).isOffered

const callAgent = ($: Engine, input: { subagent_type?: string; model?: 'haiku' | 'sonnet' | 'opus' | 'fable'; agentId?: string }) =>
  $.tool.call({ tool: 'Agent', description: 'find things', prompt: 'Goal: find things', ...input })

const spawn = ($: Engine, subagentType: string, extra: Partial<AgentSpawnInput> = {}) =>
  $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'Goal: find the retry logic',
    description: 'find retry',
    subagentType,
    provider: ENGINE,
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: subagentType === 'fork',
    ...extra,
  })

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

test('the session starts with the mode off, the command and the roles registered', async ($, on) => {
  const seen = engine(on)
  await start($)

  expect(seen.commands).toEqual(['orchestrator'])
  expect(seen.roles).toEqual(['scout', 'builder', 'verifier'])
  expect(await compose($)).toEqual(['intro'])
  expect(await offered($, 'orchestrator:scout')).toBe(false)
  expect(await offered($, 'Explore')).toBe(true)
})

test('/orchestrator on adds the section and offers the roles, and off takes both away', async ($, on) => {
  const seen = engine(on)
  await start($)

  const onResult = await run($, 'on')
  expect(onResult.text).toContain('Orchestrator mode is on')
  expect(onResult.context?.[0]).toContain('"Orchestrator mode" section')
  expect(await compose($)).toEqual(['intro', 'orchestrator:mode'])
  expect(await offered($, 'orchestrator:builder')).toBe(true)

  const offResult = await run($, 'off')
  expect(offResult.context?.[0]).toContain('no longer apply')
  expect(await compose($)).toEqual(['intro'])
  expect(await offered($, 'orchestrator:builder')).toBe(false)
})

test('a bare /orchestrator switches the mode, and an unknown word shows the usage', async ($, on) => {
  engine(on)
  await run($, '')
  expect(await compose($)).toContain('orchestrator:mode')
  expect((await run($, 'on')).text).toBe('Orchestrator mode is already on.')
  expect((await run($, 'banana')).text).toContain('Usage: /orchestrator')
  await run($, '')
  expect(await compose($)).toEqual(['intro'])
})

test("a teammate's render of the lead's prompt carries no section", async ($, on) => {
  engine(on)
  await run($, 'on')
  expect(await compose($, ['teammate'])).toEqual(['intro'])
})

test('while on, an Agent call needs a haiku or sonnet model, a fork is refused, and a subagent cannot spawn', async ($, on) => {
  engine(on)
  expect('deny' in (await callAgent($, {}))).toBe(false)
  expect('deny' in (await callAgent($, { model: 'opus' }))).toBe(false)
  expect('deny' in (await callAgent($, { subagent_type: 'fork' }))).toBe(false)

  await run($, 'on')
  const missing = await callAgent($, { subagent_type: 'orchestrator:scout' })
  expect(missing.deny).toContain('pass `model` (haiku or sonnet)')
  expect((await callAgent($, { subagent_type: 'orchestrator:scout', model: 'haiku' })).deny).toBeUndefined()
  expect((await callAgent($, { subagent_type: 'orchestrator:builder', model: 'sonnet' })).deny).toBeUndefined()
  expect((await callAgent($, { subagent_type: 'orchestrator:verifier', model: 'opus' })).deny).toContain('never opus or fable')
  expect((await callAgent($, { subagent_type: 'general-purpose', model: 'fable' })).deny).toContain('never opus or fable')
  expect((await callAgent($, { subagent_type: 'fork' })).deny).toContain('forks are refused')
  expect((await callAgent($, { model: 'sonnet', agentId: 'agent-7' })).deny).toContain('only the orchestrator spawns')
})

test('the roles run on haiku and sonnet only', () => {
  expect(ROLES.map(role => [role.name, role.model])).toEqual([
    ['scout', 'haiku'],
    ['builder', 'sonnet'],
    ['verifier', 'sonnet'],
  ])
})

test('while on, a spawn on opus or fable, a fork, or one with no model is refused, and a role runs on its own', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')

  expect((await spawn($, 'general-purpose')).deny).toContain('haiku or sonnet')
  expect((await spawn($, 'Explore', { model: 'claude-opus-5-5' })).deny).toContain('haiku or sonnet')
  expect((await spawn($, 'Plan', { model: 'fable' })).deny).toContain('haiku or sonnet')
  expect((await spawn($, 'fork')).deny).toContain('forks are refused')
  // A workflow's agent is refused without a model, and runs with one.
  const workflow = { workflow: { runId: 'wf_1', agentIndex: 1 } }
  expect((await spawn($, 'general-purpose', workflow)).deny).toContain('agent() call')
  expect((await spawn($, 'general-purpose', { ...workflow, model: 'haiku' })).deny).toBeUndefined()
  // A spawn inside a subagent is held to the same models.
  expect((await spawn($, 'general-purpose', { model: 'opus', parentAgentId: 'agent-3' })).deny).toContain('haiku or sonnet')
  expect((await spawn($, 'orchestrator:verifier')).deny).toBeUndefined()
  expect(seen.spawned.map(s => s.subagentType)).toEqual(['general-purpose', 'orchestrator:verifier'])

  // While off, the mod leaves every spawn alone.
  await run($, 'off')
  expect((await spawn($, 'general-purpose', { model: 'opus' })).deny).toBeUndefined()
  expect((await spawn($, 'fork')).deny).toBeUndefined()
})

test('while on, built-in agents get the report contract, roles do not, and the band counts tiers', async ($, on) => {
  const seen = engine(on, { models: { 'orchestrator:scout': 'claude-haiku-4-5-20251001' } })
  await spawn($, 'Explore', { model: 'sonnet' })
  expect(seen.spawned[0]?.prompt).toBe('Goal: find the retry logic')

  await run($, 'on')
  await spawn($, 'Explore', { model: 'sonnet' })
  await spawn($, 'orchestrator:scout')
  await spawn($, 'orchestrator:scout')

  expect(seen.spawned[1]?.prompt).toContain('STATUS: done | partial | blocked | failed')
  expect(seen.spawned[2]?.prompt).toBe('Goal: find the retry logic')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /delegating · 3 running · 1 sonnet · 2 haiku/ })).toBeDefined()
    await ui.unmount()
  }
  expect((await run($, 'status')).text).toBe('Orchestrator mode is on. Agents started while on: 1 sonnet, 2 haiku. 3 still running.')
})

const finish = ($: Engine, agentId: string, answer: string, durationMs: number, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  $.turn.complete({ agentId, answer, durationMs, reason, isAborted: reason === 'aborted', turnId: `turn-${agentId}` })

test('the details button opens a list of the running and the past agents', async ($, on) => {
  const seen = engine(on, { models: { 'orchestrator:scout': 'claude-haiku-4-5-20251001' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-auth', description: 'find the auth flow' })
  await spawn($, 'orchestrator:builder', { model: 'sonnet', name: 'builder-retry' })
  await spawn($, 'Explore', { model: 'haiku', description: 'list the tests' })

  // The scout reads a file, then its report comes back. A subagent's own call:
  // its loop's id rides the call, as a session stamps it.
  const scoutRead = { tool: 'Read' as const, file_path: 'auth.ts', agentId: 'agent-1' }
  await $.tool.call(scoutRead)
  await finish($, 'agent-1', 'STATUS: partial\nANSWER: found half of it', 65_000)
  // The builder works on, and the Explore agent is stopped.
  const builderGrep = { tool: 'Grep' as const, pattern: 'retry', agentId: 'agent-2' }
  const builderEdit = { tool: 'Edit' as const, file_path: 'retry.ts', old_string: 'a', new_string: 'b', agentId: 'agent-2' }
  await $.tool.call(builderGrep)
  await $.tool.call(builderEdit)
  await finish($, 'agent-3', '', 4_000, 'aborted')
  await seen.clock.advance(125_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /delegating · 1 running · 1 sonnet · 2 haiku/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /scout-auth/ })).toBeUndefined()

    await ui.press({ key: 'orchestrator-details' })
    expect(await ui.find({ type: 'Text', text: 'builder-retry · builder · sonnet · running · 2m 05s · 2 tools · Edit' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'scout-auth · scout · haiku · partial · 1m 05s · 1 tool' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'list the tests · Explore · haiku · killed · 4s · 0 tools' })).toBeDefined()

    await ui.press({ key: 'orchestrator-details' })
    expect(await ui.find({ type: 'Text', text: /scout-auth/ })).toBeUndefined()
    await ui.unmount()
  }

  // A follow-up message wakes the scout: it runs again, its time so far kept.
  const followUpRead = { tool: 'Read' as const, file_path: 'session.ts', agentId: 'agent-1' }
  await $.tool.call(followUpRead)
  await seen.clock.advance(5_000)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await ui.press({ key: 'orchestrator-details' })
  expect(await ui.find({ type: 'Text', text: 'scout-auth · scout · haiku · running · 1m 10s · 2 tools · Read' })).toBeDefined()
  await ui.unmount()
})

test('the open list fits the rows the band has, and says how many more there are', async ($, on) => {
  engine(on)
  await run($, 'on')
  for (let i = 1; i <= 15; i++) await spawn($, 'Explore', { model: 'haiku', name: `scout-${i}` })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band(false, 80, 10) })
  await ui.press({ key: 'orchestrator-details' })
  // Nine rows under the switch: eight agents, newest first, and the "more" row.
  expect(await ui.find({ type: 'Text', text: /^scout-15 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^scout-8 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^scout-7 ·/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /7 more/ })).toBeDefined()
  await ui.unmount()
})

test('while on, a large direct read gets a note with its size, and a small one does not', async ($, on) => {
  engine(on)
  await run($, 'on')
  const big = await $.tool.call({ tool: 'Read', file_path: 'big.ts' })
  expect(big.context?.[0]).toContain('about 3000 tokens')
  const small = await $.tool.call({ tool: 'Read', file_path: 'small.ts' })
  expect(small.context).toBeUndefined()
  // A subagent's own read: its loop's id rides the call, as a session stamps it.
  const subagentRead = { tool: 'Read' as const, file_path: 'big.ts', agentId: 'agent-2' }
  const inSubagent = await $.tool.call(subagentRead)
  expect(inSubagent.context).toBeUndefined()

  await run($, 'off')
  expect((await $.tool.call({ tool: 'Read', file_path: 'big.ts' })).context).toBeUndefined()
})

test('the mode is saved for the session id and comes back on a resumed start', async ($, on) => {
  engine(on, { store: { sessions: { 'session-a': { isOn: true, at: 1 } } } })
  await start($)
  expect(await compose($)).toContain('orchestrator:mode')
})

test('switching the mode writes it to the store under the session id', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  const saved = seen.store.sessions as Record<string, { isOn: boolean }>
  expect(saved['session-a']?.isOn).toBe(true)
  await run($, 'off')
  expect((seen.store.sessions as Record<string, { isOn: boolean }>)['session-a']?.isOn).toBe(false)
})

test('the band shows the switch off, and a press switches the mode', async ($, on) => {
  const seen = engine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: 'Claude works directly' })).toBeDefined()
    // With no agents yet, there is no list to open.
    expect(await ui.find({ key: 'orchestrator-details' })).toBeUndefined()
    // The band other plugins drew stays, under the switch.
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    await ui.press({ key: 'orchestrator-on' })
    expect(await ui.find({ type: 'Text', text: 'delegating · no agents yet' })).toBeDefined()
    expect(await compose($)).toContain('orchestrator:mode')

    await ui.press({ key: 'orchestrator-off' })
    expect(await ui.find({ type: 'Text', text: 'Claude works directly' })).toBeDefined()
    expect(await compose($)).toEqual(['intro'])
    await ui.unmount()
  }
  expect((seen.store.sessions as Record<string, { isOn: boolean }>)['session-a']?.isOn).toBe(false)
})

test('the desktop draws the switch as native buttons, the one that holds primary, with no fixed colors', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...band() })
  expect((await ui.find({ key: 'orchestrator-off' }))?.props).toMatchObject({ label: 'off', variant: 'primary' })
  expect((await ui.find({ key: 'orchestrator-on' }))?.props).toMatchObject({ label: 'on', variant: 'secondary' })
  expect((await ui.find({ key: 'orchestrator-on' }))?.props.plain).toBeUndefined()

  await ui.press({ key: 'orchestrator-on' })
  expect((await ui.find({ key: 'orchestrator-off' }))?.props.variant).toBe('secondary')
  expect((await ui.find({ key: 'orchestrator-on' }))?.props.variant).toBe('primary')
  await ui.unmount()

  // The terminal keeps its filled segments.
  const terminal = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect((await terminal.find({ key: 'orchestrator-on' }))?.props).toMatchObject({ label: ' on ', plain: true })
  await terminal.unmount()
})

test('the band follows /orchestrator, steps aside for a survey, and fits a narrow width', async ($, on) => {
  engine(on)
  await run($, 'on')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect(await ui.find({ type: 'Text', text: 'delegating · no agents yet' })).toBeDefined()
  await ui.unmount()

  const survey = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band(true) })
  expect(await survey.find({ key: 'orchestrator-on' })).toBeUndefined()
  await survey.unmount()

  const narrow = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band(false, 24) })
  expect(await narrow.find({ key: 'orchestrator-on' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /no agents/ })).toBeUndefined()
  await narrow.unmount()
})

const type = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('after a press, the next prompt tells the model once, and a slash command does not take the note', async ($, on) => {
  const seen = engine(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await ui.press({ key: 'orchestrator-on' })
  await ui.unmount()

  await type($, '/compact')
  await type($, 'plan the migration')
  await type($, 'and then run it')
  expect(seen.prompts[1]?.context?.[0]).toContain('Orchestrator mode is now on')
  expect(seen.prompts[2]?.context).toBeUndefined()
  expect(seen.prompts[0]?.context).toBeUndefined()
})

test('two presses before a prompt leave no note, and the command clears a waiting one', async ($, on) => {
  const seen = engine(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await ui.press({ key: 'orchestrator-on' })
  await ui.press({ key: 'orchestrator-off' })
  await type($, 'hello')
  expect(seen.prompts[0]?.context).toBeUndefined()

  await ui.press({ key: 'orchestrator-on' })
  await ui.unmount()
  await run($, 'off')
  await type($, 'hello again')
  expect(seen.prompts[1]?.context).toBeUndefined()
})

test('pressing the segment that already holds changes nothing', async ($, on) => {
  const seen = engine(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await ui.press({ key: 'orchestrator-off' })
  await ui.unmount()
  await type($, 'hello')
  expect(seen.prompts[0]?.context).toBeUndefined()
  expect(await compose($)).toEqual(['intro'])
  expect(seen.store.sessions).toBeUndefined()
})
