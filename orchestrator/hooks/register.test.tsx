import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, TurnUsage } from 'claude-code'

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
  const seen = { requested: 0, details: {} as unknown, usages: [] as (TurnUsage | null)[], store, clock, prompts: [] as { text: string; context?: readonly string[] }[], spawned: [] as AgentSpawnInput[], roles: [] as string[], commands: [] as string[], opened: [] as { id: string; title?: string }[] }
  on('ui.open', (_$, e) => {
    seen.opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
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
  on('session.cwd', () => ({ value: '/repo' }))
  // Keeps the details the plugin writes: the test's `$` cannot read the state back.
  on('state.set', (_$, e, next) => {
    if (e.plugin === PLUGIN && e.key === 'details') seen.details = JSON.parse(JSON.stringify(e.value))
    return next(e)
  })
  // A model request answers the next usage the test queued, else a small one.
  on('turn.step', async function* (_$, e) {
    seen.requested++
    const usage = seen.usages.length > 0 ? seen.usages.shift()! : { model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('tool.call', (_$, e) => (e.tool === 'Bash' && e.command === 'denied' ? { deny: 'Not allowed here.' } : e.tool === 'Bash' && e.command === 'colored' ? { result: {} as never, text: '\u001b[31mred\u001b[0m\f' } : e.tool === 'Bash' && e.command === 'numeric' ? { result: {} as never, text: 42 as never } : {
    result: {} as never,
    text: e.tool === 'Read' ? 'x'.repeat(e.file_path === 'big.ts' ? 12_000 : 200) : 'ok',
    // A command named `false` fails, as the shell's own does.
    ...(e.tool === 'Bash' && e.command === 'false' ? { isError: true as const } : {}),
  }))
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
  // The note carries the rules whole: a mid-session switch may never reach the system prompt.
  expect(onResult.context?.[0]).toContain('Its rules follow')
  expect(onResult.context?.[0]).toContain('# Orchestrator mode')
  expect(onResult.context?.[0]).toContain('## Model and effort')
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

test('while on, an Agent call needs a haiku or sonnet model unless it is a role, a fork is refused, and a subagent cannot spawn', async ($, on) => {
  engine(on)
  expect('deny' in (await callAgent($, {}))).toBe(false)
  expect('deny' in (await callAgent($, { model: 'opus' }))).toBe(false)
  expect('deny' in (await callAgent($, { subagent_type: 'fork' }))).toBe(false)

  await run($, 'on')
  const missing = await callAgent($, { subagent_type: 'general-purpose' })
  expect(missing.deny).toContain('pass `model` (haiku or sonnet)')
  // A role left without a model runs on its own: the scout on haiku.
  expect((await callAgent($, { subagent_type: 'orchestrator:scout' })).deny).toBeUndefined()
  expect((await callAgent($, { subagent_type: 'orchestrator:scout', model: 'haiku' })).deny).toBeUndefined()
  expect((await callAgent($, { subagent_type: 'orchestrator:builder', model: 'sonnet' })).deny).toBeUndefined()
  expect((await callAgent($, { subagent_type: 'orchestrator:verifier', model: 'opus' })).deny).toContain('never opus or fable')
  expect((await callAgent($, { subagent_type: 'general-purpose', model: 'fable' })).deny).toContain('never opus or fable')
  expect((await callAgent($, { subagent_type: 'fork' })).deny).toContain('forks are refused')
  expect((await callAgent($, { model: 'sonnet', agentId: 'agent-7' })).deny).toContain('only the orchestrator spawns')
})

test('the roles run on haiku 5.5 and sonnet 5.5 only', () => {
  expect(ROLES.map(role => [role.name, role.model])).toEqual([
    ['scout', 'claude-haiku-5-5'],
    ['builder', 'claude-sonnet-5-5'],
    ['verifier', 'claude-sonnet-5-5'],
  ])
})

test('while on, every haiku or sonnet spawn reaches the engine pinned to its 5.5 model, and while off none is touched', async ($, on) => {
  const seen = engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await spawn($, 'Explore', { model: 'haiku' })
  expect(seen.spawned.map(s => s.model)).toEqual(['haiku'])

  await run($, 'on')
  // The Agent tool names a tier, a script or a teammate may name a version: all land on 5.5.
  await spawn($, 'Explore', { model: 'haiku' })
  await spawn($, 'Explore', { model: 'sonnet' })
  await spawn($, 'general-purpose', { model: 'claude-haiku-4-5-20251001' })
  await spawn($, 'general-purpose', { model: 'claude-sonnet-4-5' })
  await spawn($, 'general-purpose', { workflow: { runId: 'wf_1', agentIndex: 1 }, model: 'haiku' })
  await spawn($, 'general-purpose', { model: 'sonnet', parentAgentId: 'agent-3' })
  // A role passes no model and keeps the 5.5 model its own spec carries.
  await spawn($, 'orchestrator:scout')

  expect(seen.spawned.slice(1).map(s => s.model)).toEqual([
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    undefined,
  ])
  // The band still counts them by tier, because the tier is read from the pinned id.
  // A spawn inside a subagent is not tracked, so six of the seven are on the list.
  expect((await run($, 'status')).text).toBe('Orchestrator mode is on. Agents started while on: 2 sonnet, 4 haiku. 6 still running.')
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
  expect(seen.spawned[1]?.prompt).toContain('context budget for this task is about 150K tokens')
  expect(seen.spawned[2]?.prompt).toBe('Goal: find the retry logic')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /delegating · 3 running · 1 sonnet · 2 haiku/ })).toBeDefined()
    await ui.unmount()
  }
  expect((await run($, 'status')).text).toBe('Orchestrator mode is on. Agents started while on: 1 sonnet, 2 haiku. 3 still running.')
})

const detailsPane = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'orchestrator-agent',
  props: { title: 'Agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

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
    expect(await ui.find({ type: 'Button', text: 'builder-retry · builder · sonnet · running · 2m 05s · 2 tools · Edit' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'scout-auth · scout · haiku · partial · 1m 05s · 1 tool' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'list the tests · Explore · haiku · killed · 4s · 0 tools' })).toBeDefined()

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
  expect(await ui.find({ type: 'Button', text: 'scout-auth · scout · haiku · running · 1m 10s · 2 tools · Read' })).toBeDefined()
  await ui.unmount()
})

test('the open list fits the rows the band has, and says how many more there are', async ($, on) => {
  engine(on)
  await run($, 'on')
  for (let i = 1; i <= 15; i++) await spawn($, 'Explore', { model: 'haiku', name: `scout-${i}` })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band(false, 80, 10) })
  await ui.press({ key: 'orchestrator-details' })
  // Nine rows under the switch: eight agents, newest first, and the "more" row.
  expect(await ui.find({ type: 'Button', text: /^scout-15 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^scout-8 ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^scout-7 ·/ })).toBeUndefined()
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

test('a press on an agent row opens a pane with its card, outcome, steps and brief', async ($, on) => {
  const seen = engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-auth', description: 'find the auth flow', prompt: 'Goal: find where the auth token is refreshed' })
  await spawn($, 'orchestrator:builder', { model: 'sonnet', name: 'builder-retry', prompt: 'Goal: add a retry' })
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/src/auth.ts', agentId: 'agent-1' })
  await finish($, 'agent-1', 'STATUS: done\nANSWER: refreshed in src/auth.ts:42', 30_000)

  // The list stays open across mounts: open it once.
  const opener = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await opener.press({ key: 'orchestrator-details' })
  await opener.unmount()

  for (const surface of SURFACES) {
    const band_ = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    await band_.press({ key: 'orchestrator-agent-agent-1' })
    await band_.unmount()
    expect(seen.opened.at(-1)).toEqual({ id: 'orchestrator-agent', title: 'Agent · scout-auth' })

    const pane = await $.ui.mount({ ...detailsPane, surface })
    expect(await pane.find({ type: 'Text', text: 'scout-auth' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' DONE ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Haiku 5.5' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'refreshed in `src/auth.ts:42`' })).toBeDefined()
    // The step, relative to the session's folder, and the file it read.
    expect(await pane.find({ type: 'Text', text: 'src/auth.ts' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Files read' })).toBeDefined()
    // The answer sits in its own box, under a small caption.
    expect(await pane.find({ type: 'Text', text: 'Answer' })).toBeDefined()
    // The brief is on its own tab, in a card.
    await pane.press({ key: 'orchestrator-tab-brief' })
    expect(await pane.find({ type: 'Markdown', text: 'find where the auth token is refreshed' })).toBeDefined()
    await pane.press({ key: 'orchestrator-tab-overview' })
    await pane.unmount()
  }

  // Another row's press moves the pane to that agent, still working with no report.
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await ui.press({ key: 'orchestrator-agent-agent-2' })
  await ui.unmount()
  const pane = await $.ui.mount({ ...detailsPane, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' RUNNING ' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '● Working' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'No tool calls yet.' })).toBeDefined()
  await pane.unmount()
})

test('the pane tells the work as phases, marks the failed ones, and splits the report by field', async ($, on) => {
  engine(on, { models: { 'orchestrator:builder': 'claude-sonnet-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:builder', { name: 'builder-auth', prompt: 'Goal: refresh the token' })
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/src/auth.ts', offset: 10, limit: 20, agentId: 'agent-1' })
  await $.tool.call({ tool: 'Grep', pattern: 'refresh', path: '/repo/src', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false', agentId: 'agent-1' } as never)
  await finish(
    $,
    'agent-1',
    'I looked around first.\nSTATUS: partial\nANSWER: the refresh now retries once\nEVIDENCE: src/auth.ts:42 retries; `false` failed\nCHANGES: src/auth.ts: one retry\nOPEN: the tests were not run',
    20_000,
  )
  const opener = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await opener.press({ key: 'orchestrator-details' })
  await opener.unmount()

  for (const surface of SURFACES) {
    const band_ = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    await band_.press({ key: 'orchestrator-agent-agent-1' })
    await band_.unmount()

    const pane = await $.ui.mount({ ...detailsPane, surface })
    expect(await pane.find({ type: 'Text', text: ' PARTIAL ' })).toBeDefined()
    // Each phase, by what it acted on, the shell's failure marked.
    expect(await pane.find({ type: 'Text', text: 'src/auth.ts:10-30' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '"refresh" in src' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✗ ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'file edited' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✎ src/auth.ts' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /4 tools · 1 failed/ })).toBeDefined()
    // The overview says what changed and how much is open; the report tab has every field.
    expect(await pane.find({ type: 'Markdown', text: 'the refresh now retries once' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✎ Top changes' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⚑ 1 open question or risk' })).toBeDefined()
    await pane.press({ key: 'orchestrator-tab-report' })
    // The report, a field to a block: one written as one line with "; " is a list.
    expect(await pane.find({ type: 'Markdown', text: 'the refresh now retries once' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: '- `src/auth.ts:42` retries  \n- `false` failed' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'the tests were not run' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'I looked around first.' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✎ Changes' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⌕ Evidence' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⚑ Open questions & risks' })).toBeDefined()
    await pane.press({ key: 'orchestrator-tab-overview' })
    await pane.unmount()
  }
})

// The pane for the agent pressed first, its list opened once for every surface.
async function showAgent($: Engine, id: string, surface: (typeof SURFACES)[number], bodyColumns = 80, tab = 'overview') {
  const band_ = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
  await band_.press({ key: `orchestrator-agent-${id}` })
  await band_.unmount()
  const pane = await $.ui.mount({ ...detailsPane, props: { ...detailsPane.props, bodyColumns }, surface })
  // The open tab outlives a mount: each test starts where it says.
  await pane.press({ key: `orchestrator-tab-${tab}` })
  return pane
}
const showFirst = ($: Engine, surface: (typeof SURFACES)[number]) => showAgent($, 'agent-1', surface)
async function openList($: Engine) {
  const opener = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await opener.press({ key: 'orchestrator-details' })
  await opener.unmount()
}

test('consecutive calls of one kind form a phase, with its time, its tally, its files and its failures', async ($, on) => {
  engine(on, { models: { 'orchestrator:builder': 'claude-sonnet-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:builder', { name: 'builder-auth' })
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/src/auth.ts', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/src/session.ts', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Grep', pattern: 'refresh', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false', agentId: 'agent-1' } as never)
  await finish($, 'agent-1', 'STATUS: done\nANSWER: retried', 9_000)
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    // Three phases, each numbered and named in order.
    expect(await pane.find({ type: 'Text', text: '①' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '②' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '③' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '④' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /^Explored$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Edited$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Ran commands$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Read ×2 · Grep ×1$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Edit ×1$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Bash ×1$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\d+:\d\d–\d+:\d\d$/ })).toBeDefined()
    // The edit phase names its file, the explore phase its targets, the run its command, failed.
    expect(await pane.find({ type: 'Text', text: /^✎ src\/auth\.ts$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^src\/session\.ts$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^false$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✗ ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^1 failed$/ })).toBeDefined()
    // Nothing is running, so none is in progress.
    expect(await pane.find({ type: 'Text', text: '● in progress' })).toBeUndefined()
    await pane.unmount()
  }
})

test('a phase of many targets shows three and counts the rest', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-many' })
  for (let i = 1; i <= 5; i++) await $.tool.call({ tool: 'Read' as const, file_path: `/repo/f${i}.ts`, agentId: 'agent-1' })
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    expect(await pane.find({ type: 'Text', text: /^f3\.ts$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^f4\.ts$/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '+2 more' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Read ×5$/ })).toBeDefined()
    await pane.unmount()
  }
})

test('the tool mix is one stacked bar with a legend, and tools of one color take different fills', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-mix' })
  for (let i = 1; i <= 6; i++) await $.tool.call({ tool: 'Read' as const, file_path: `/repo/f${i}.ts`, agentId: 'agent-1' })
  for (let i = 1; i <= 3; i++) await $.tool.call({ tool: 'Grep', pattern: `p${i}`, agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' } as never)
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    // Read and Grep share a color: the first fills with ■, the second with ▓.
    expect(await pane.find({ type: 'Text', text: /^■ Read 6$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^▓ Grep 3$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^■ Bash 1$/ })).toBeDefined()
    if (surface === 'desktop') {
      // Desktop draws the bar; Grep takes a lighter shade of the color it shares with Read.
      const bar = (await pane.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('Tool mix'))
      expect(bar?.props.alt).toBe('Tool mix: Read 6, Grep 3, Bash 1')
      expect(String(bar?.props.source)).toContain('fill-opacity="0.6"')
    } else {
      // Its bar spans at most 40 cells, in proportion: 6 of 10 calls take 24.
      expect(await pane.find({ type: 'Text', text: /^█{24}$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^▓{12}$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^█{4}$/ })).toBeDefined()
    }
    await pane.unmount()
  }
})

test('a status written in markdown or with a full stop still reads as the status', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-bold' })
  await spawn($, 'orchestrator:scout', { name: 'scout-dot' })
  await finish($, 'agent-1', '**STATUS:** partial\nANSWER: half of it', 5_000)
  await finish($, 'agent-2', '- STATUS: partial.\nANSWER: half of it\nEVIDENCE: a.ts:1\nOPEN: the rest', 5_000)
  await openList($)

  for (const surface of SURFACES) {
    const band_ = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await band_.find({ type: 'Button', text: /^scout-bold · scout · haiku · partial ·/ })).toBeDefined()
    expect(await band_.find({ type: 'Button', text: /^scout-dot · scout · haiku · partial ·/ })).toBeDefined()
    await band_.unmount()

    // The card's chip agrees with the report, and the open questions come first.
    const pane = await showFirst($, surface)
    expect(await pane.find({ type: 'Text', text: ' PARTIAL ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /reported/ })).toBeUndefined()
    await pane.unmount()

    const dotted = await showAgent($, 'agent-2', surface, 80, 'report')
    const labels = await dotted.findAll({ type: 'Text', text: /^(⌕ Evidence|⚑ Open questions & risks)$/ })
    expect(labels.map(l => l.text)).toEqual(['⚑ Open questions & risks', '⌕ Evidence'])
    await dotted.unmount()
  }
})

test('more tools than the bar has cells fold the smallest into one other segment, filling the width exactly', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-wide' })
  for (let i = 1; i <= 20; i++) await $.tool.call({ tool: `mcp__t__a${i}`, agentId: 'agent-1' } as never)
  await openList($)

  for (const surface of SURFACES) {
    // 20 columns leave 16 cells: 15 tools and the rest as "other".
    const pane = await showAgent($, 'agent-1', surface, 20)
    if (surface === 'terminal') {
      const cells = (await pane.findAll({ type: 'Text', text: /^[█▓▒░]+$/ })).reduce((sum, t) => sum + String(t.text).length, 0)
      expect(cells).toBe(16)
    }
    expect(await pane.find({ type: 'Text', text: /other 5$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /mcp__t__a16 1/ })).toBeUndefined()
    await pane.unmount()
  }
})

test('a call with no target adds no empty detail line', async ($, on) => {
  engine(on, { models: { 'orchestrator:builder': 'claude-sonnet-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:builder', { name: 'builder-bare' })
  await $.tool.call({ tool: 'Edit', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', agentId: 'agent-1' } as never)
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    expect(await pane.find({ type: 'Text', text: /^Edited$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Ran commands$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^✎\s*$/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /^[✓✗]\s*$/ })).toBeUndefined()
    await pane.unmount()
  }
})

test('the overview shows the latest ten phases and counts the earlier ones', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-long' })
  for (let i = 1; i <= 6; i++) {
    await $.tool.call({ tool: 'Read' as const, file_path: `/repo/f${i}.ts`, agentId: 'agent-1' })
    await $.tool.call({ tool: 'Bash', command: `echo ${i}`, agentId: 'agent-1' } as never)
  }
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    expect(await pane.find({ type: 'Text', text: '⋯ 2 earlier phases' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '②' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '③' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⑫' })).toBeDefined()
    // Every call is on the Steps tab, which has no more than 40 rows to fold.
    await pane.press({ key: 'orchestrator-tab-steps' })
    expect(await pane.find({ key: 'orchestrator-step-1' })).toBeDefined()
    expect(await pane.find({ key: 'orchestrator-steps-toggle' })).toBeUndefined()
    await pane.unmount()
  }
})

test("a verifier's verdict is drawn as a chip", async ($, on) => {
  engine(on, { models: { 'orchestrator:verifier': 'claude-sonnet-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:verifier', { name: 'check-auth' })
  await finish($, 'agent-1', 'STATUS: done\nANSWER: FAIL: the retry never fires', 5_000)
  const band_ = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...band() })
  await band_.press({ key: 'orchestrator-details' })
  await band_.press({ key: 'orchestrator-agent-agent-1' })
  await band_.unmount()
  const pane = await $.ui.mount({ ...detailsPane, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: ' FAIL ' })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: 'the retry never fires' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'No tool calls: it answered from its brief.' })).toBeDefined()
  await pane.unmount()
})

test('the steps tab shows the latest 40 calls until all are asked for, and the brief is never folded', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  const brief = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  await spawn($, 'orchestrator:scout', { name: 'scout-many', prompt: brief })
  for (let i = 1; i <= 45; i++) await $.tool.call({ tool: 'Read' as const, file_path: `/repo/f${i}.ts`, agentId: 'agent-1' })
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'steps')
    expect((await pane.find({ key: 'orchestrator-steps-toggle' }))?.props.label).toBe('▾ Show all 45 calls')
    expect(await pane.find({ type: 'Text', text: '⋯ 5 earlier calls' })).toBeDefined()
    expect(await pane.find({ key: 'orchestrator-step-5' })).toBeUndefined()
    expect(await pane.find({ key: 'orchestrator-step-6' })).toBeDefined()
    expect(await pane.find({ key: 'orchestrator-step-45' })).toBeDefined()

    await pane.press({ key: 'orchestrator-steps-toggle' })
    expect((await pane.find({ key: 'orchestrator-steps-toggle' }))?.props.label).toBe('▴ Show the latest 40')
    expect(await pane.find({ key: 'orchestrator-step-1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /earlier calls/ })).toBeUndefined()
    await pane.press({ key: 'orchestrator-steps-toggle' })

    // The brief has no fold: the last line is there at once.
    await pane.press({ key: 'orchestrator-tab-brief' })
    expect(await pane.find({ type: 'Markdown', text: /line 30$/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /Show/ })).toBeUndefined()
    await pane.unmount()
  }
})

test('a report that follows no field is drawn whole', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-free' })
  await finish($, 'agent-1', 'It is in auth.ts.\nNothing else to say.', 3_000)
  const band_ = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await band_.press({ key: 'orchestrator-details' })
  await band_.press({ key: 'orchestrator-agent-agent-1' })
  await band_.unmount()
  const pane = await $.ui.mount({ ...detailsPane, surface: 'terminal' })
  expect(await pane.find({ type: 'Markdown', text: 'It is in auth.ts.  \nNothing else to say.' })).toBeDefined()
  await pane.unmount()
})

test('the details pane with no agent pressed says so', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount({ ...detailsPane, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /No agent to show/ })).toBeDefined()
  await pane.unmount()
})

test('a follow-up answered with no tool call still updates the report and the time', async ($, on) => {
  const seen = engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-auth' })
  await finish($, 'agent-1', 'STATUS: partial\nANSWER: first answer', 10_000)
  // SendMessage wakes it, and it answers straight away: no tool call marks it running.
  await finish($, 'agent-1', 'STATUS: done\nANSWER: second answer', 5_000)
  await seen.clock.advance(1_000)

  const band_ = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  await band_.press({ key: 'orchestrator-details' })
  expect(await band_.find({ type: 'Button', text: 'scout-auth · scout · haiku · done · 15s · 0 tools' })).toBeDefined()
  await band_.press({ key: 'orchestrator-agent-agent-1' })
  await band_.unmount()
  const pane = await $.ui.mount({ ...detailsPane, surface: 'terminal' })
  expect(await pane.find({ type: 'Markdown', text: 'second answer' })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: /first answer/ })).toBeUndefined()
  await pane.unmount()
})

// One model request of a loop, drained as the engine does, and its response.
const step = async ($: Engine, agentId?: string) => {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-haiku-5-5', messageCount: 3, ...(agentId !== undefined ? { agentId } : {}) })
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}
const usage = (input: number, cacheRead: number, cacheCreation: number, output: number): TurnUsage => ({
  model: 'claude-haiku-5-5',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
})
// The details the mod wrote last, as the engine's state received them.
const detailsOf = (seen: { details: unknown }) =>
  seen.details as Record<string, { brief: string; steps?: { n: number; tool: string; input?: string; output?: string }[]; requests?: { at: number; prompt: number; cacheRead: number; output: number; steps: number }[] }>

test('a subagent request is recorded with its prompt, its cache and its output, the main loop and a null usage are not', async ($, on) => {
  const seen = engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-auth' })
  await spawn($, 'orchestrator:scout', { name: 'scout-two' })

  seen.usages.push(usage(100, 5_000, 2_000, 300))
  expect((await step($, 'agent-1')).usage?.output_tokens).toBe(300)
  await seen.clock.advance(4_000)
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/a.ts', agentId: 'agent-1' })
  seen.usages.push(usage(50, 9_000, 0, 120))
  await step($, 'agent-1')
  // A response with no usage, the main loop's, and an agent the mod keeps nothing of.
  seen.usages.push(null)
  expect((await step($, 'agent-1')).usage).toBeNull()
  seen.usages.push(usage(1, 1, 1, 1))
  await step($)
  seen.usages.push(usage(1, 1, 1, 1))
  await step($, 'agent-9')

  const all = detailsOf(seen)
  expect(all['agent-1']?.requests).toEqual([
    { at: 0, prompt: 7_100, cacheRead: 5_000, output: 300, steps: 0 },
    { at: 4_000, prompt: 9_050, cacheRead: 9_000, output: 120, steps: 1 },
  ])
  expect(all['agent-2']?.requests).toBeUndefined()
  expect(all['agent-9']).toBeUndefined()
})

test('a request is sent once, and only the latest 150 are kept', { timeoutMs: 30_000 }, async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  await spawn($, 'orchestrator:scout')
  for (let i = 1; i <= 155; i++) {
    seen.usages.push(usage(i, 0, 0, 1))
    await step($, 'agent-1')
  }
  expect(seen.requested).toBe(155)
  const requests = detailsOf(seen)['agent-1']?.requests ?? []
  expect(requests).toHaveLength(150)
  expect(requests[0]?.prompt).toBe(6)
  expect(requests.at(-1)?.prompt).toBe(155)
})

test('a step keeps the call input without the engine keys, clipped, and the output or the deny', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  await spawn($, 'orchestrator:builder', { model: 'sonnet' })
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/src/auth.ts', offset: 10, limit: 20, agentId: 'agent-1', tool_use_id: 'tu-9' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x'.repeat(2_000), new_string: 'b', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'denied', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Read' as const, file_path: 'big.ts', agentId: 'agent-1' })

  const steps = detailsOf(seen)['agent-1']?.steps ?? []
  expect(JSON.parse(steps[0]?.input ?? '')).toEqual({ file_path: '/repo/src/auth.ts', offset: 10, limit: 20 })
  expect(steps[0]?.input).toContain('\n  "offset": 10')
  expect(steps[0]?.input).not.toMatch(/agentId|tool_use_id|"tool"/)
  expect(steps[0]?.output).toBe('x'.repeat(200))
  expect(steps[1]?.input?.length).toBeLessThan(700)
  expect(steps[1]?.input).toMatch(/… \(\d+ more characters\)$/)
  expect(steps[1]?.output).toBe('ok')
  expect(JSON.parse(steps[2]?.input ?? '')).toEqual({ command: 'denied' })
  expect(steps[2]?.output).toBe('Not allowed here.')
  expect(steps[3]?.output).toMatch(/^x{600}\n… \(11400 more characters\)$/)
})

test('only the 15 newest agents keep each call input and output', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  for (let i = 1; i <= 16; i++) {
    await spawn($, 'orchestrator:scout', { prompt: `Goal ${i}` })
    await $.tool.call({ tool: 'Read' as const, file_path: `/repo/f${i}.ts`, agentId: `agent-${i}` })
  }
  // Agent 1 held its IO until the 16th spawned.
  let all = detailsOf(seen)
  expect(all['agent-1']?.steps?.[0]?.input).toBeUndefined()
  expect(all['agent-1']?.steps?.[0]?.output).toBeUndefined()
  expect(all['agent-1']?.steps?.[0]?.tool).toBe('Read')
  for (let i = 2; i <= 16; i++) expect(all[`agent-${i}`]?.steps?.[0]?.output).toBe('x'.repeat(200))

  await spawn($, 'orchestrator:scout', { prompt: 'Goal 17' })
  all = detailsOf(seen)
  expect(all['agent-2']?.steps?.[0]?.input).toBeUndefined()
  expect(all['agent-3']?.steps?.[0]?.input).toContain('/repo/f3.ts')
})

test('a brief and a report of ten thousand characters are kept whole', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  const brief = `Goal: ${'b'.repeat(9_994)}`
  await spawn($, 'orchestrator:scout', { prompt: brief })
  await finish($, 'agent-1', `STATUS: done\nANSWER: ${'r'.repeat(9_990)}`, 1_000)
  const kept = detailsOf(seen)['agent-1'] as { brief: string; report: string | null }
  expect(kept.brief).toBe(brief)
  expect(kept.report).toBe(`STATUS: done\nANSWER: ${'r'.repeat(9_990)}`)
})

// ---- The agent inspector: its tabs

// An agent that read, searched, edited and ran a command, four model requests
// (the last one over the budget), and a report: every tab has something to show.
async function seedInspector($: Engine, seen: ReturnType<typeof engine>, brief = 'Goal: add a retry\nContext: see src/auth.ts\nTask: edit it\nDone when: tests pass\nReturn: the diff') {
  await run($, 'on')
  await spawn($, 'orchestrator:builder', { model: 'sonnet', name: 'builder-inspect', description: 'add the retry', prompt: brief })
  const call = (input: Record<string, unknown>) => $.tool.call({ ...input, agentId: 'agent-1' } as never)
  seen.usages.push(usage(20_000, 0, 0, 300))
  await step($, 'agent-1')
  await seen.clock.advance(2_000)
  await call({ tool: 'Read', file_path: '/repo/src/big.ts' })
  seen.usages.push(usage(10, 40_000, 0, 200))
  await step($, 'agent-1')
  await call({ tool: 'Grep', pattern: 'retry', path: '/repo/src' })
  await call({ tool: 'Bash', command: 'false' })
  seen.usages.push(usage(10, 45_000, 0, 100))
  await step($, 'agent-1')
  await call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' })
  seen.usages.push(usage(0, 160_000, 0, 400))
  await step($, 'agent-1')
  await finish($, 'agent-1', 'STATUS: done\nANSWER: PASS: the retry works\nEVIDENCE: src/auth.ts:42 retries\nCHANGES: src/auth.ts: one retry\nOPEN: the docs', 9_000)
  await openList($)
}
const svgAlts = async (pane: Awaited<ReturnType<typeof showAgent>>) => (await pane.findAll({ type: 'Svg' })).map(s => String(s.props.alt))

test('the tab bar counts what each tab holds, switches on a press, and marks the open one', async ($, on) => {
  const seen = engine(on)
  await seedInspector($, seen)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    const labels = async () => Object.fromEntries(await Promise.all(['overview', 'brief', 'steps', 'tokens', 'report'].map(async t => [t, String((await pane.find({ key: `orchestrator-tab-${t}` }))?.props.label).trim()])))
    // Desktop keeps the labels short so the five fit one row.
    if (surface === 'desktop') expect(await labels()).toEqual({ overview: 'Overview', brief: 'Brief', steps: 'Steps', tokens: 'Tokens', report: 'Report' })
    else expect(await labels()).toEqual({ overview: 'Overview', brief: 'Brief', steps: 'Steps 4', tokens: 'Tokens 160K', report: 'Report ✓' })
    if (surface === 'desktop') expect((await pane.find({ key: 'orchestrator-tab-overview' }))?.props.variant).toBe('primary')
    else expect(await pane.find({ type: 'Text', text: ' Overview '})).toBeDefined()
    expect((await pane.find({ key: 'orchestrator-tab-brief' }))?.props.hotkey).toBe('2')

    await pane.press({ key: 'orchestrator-tab-tokens' })
    expect(await pane.find({ type: 'Text', text: /^biggest jumps$/i })).toBeDefined()
    if (surface === 'desktop') {
      expect((await pane.find({ key: 'orchestrator-tab-tokens' }))?.props.variant).toBe('primary')
      expect((await pane.find({ key: 'orchestrator-tab-overview' }))?.props.variant).toBe('secondary')
    } else expect(await pane.find({ type: 'Text', text: ' Tokens 160K ' })).toBeDefined()
    await pane.press({ key: 'orchestrator-tab-overview' })
    await pane.unmount()
  }
})

test('the overview says who the agent is, the outcome and its numbers, with charts on desktop and text twins on the terminal', async ($, on) => {
  const seen = engine(on)
  await seedInspector($, seen)

  for (const surface of SURFACES) {
    const pane = await showFirst($, surface)
    expect(await pane.find({ type: 'Text', text: 'builder-inspect' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'add the retry' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' DONE ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' PASS ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'builder' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'the retry works' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⚑ 1 open question or risk' })).toBeDefined()
    // Tiles: output tokens, run time, calls, files edited, failed calls.
    expect(await pane.find({ type: 'Text', text: '1K' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'tokens out' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '4' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'files edited'.replace('files', 'file') })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'failed call' })).toBeDefined()
    if (surface === 'desktop') {
      const alts = await svgAlts(pane)
      expect(alts).toContain('Agent done')
      expect(alts).toContain('Peak context 160K of 150K, 107%')
      expect(alts).toContain('Context per request: 4 requests, peak 160K of 150K, now 160K')
      expect(alts.some(a => /^Timeline of 4 tool calls/.test(a))).toBe(true)
      for (const svg of await pane.findAll({ type: 'Svg' })) {
        expect(svg.props.isInteractive).toBe(true)
        expect(String(svg.props.source).startsWith('<svg')).toBe(true)
      }
    } else {
      expect(await pane.findAll({ type: 'Svg' })).toEqual([])
      expect(await pane.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]+$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^█+░* 107%/ })).toBeDefined()
    }
    await pane.unmount()
  }
})

test('the brief tab shows the whole brief, a card per section, with its size', async ($, on) => {
  const seen = engine(on)
  const brief = `Read this first.\n## Goal\nadd a retry\n**Context:** see src/auth.ts\nTASK: edit it\n${'x'.repeat(5_000)}\nDone When: tests pass\nReturn: the diff\nlast line`
  await seedInspector($, seen, brief)

  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'brief')
    const cards = await pane.findAll({ type: 'Text', text: /^(📄 Intro|🎯 Goal|🧭 Context|🛠 Task|✅ Done when|📦 Return)$/ })
    expect(cards.map(c => c.text)).toEqual(['📄 Intro', '🎯 Goal', '🧭 Context', '🛠 Task', '✅ Done when', '📦 Return'])
    expect(await pane.find({ type: 'Markdown', text: 'Read this first.' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'add a retry' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'x'.repeat(5_000) })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: /the diff\s+\nlast line$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `${brief.length.toLocaleString('en-US')} characters · ≈${Math.round(brief.length / 4000 * 10) / 10}K tokens` })).toBeDefined()
    await pane.unmount()
  }
})

test('a brief with no section is one card, and an agent with no kept brief says so', async ($, on) => {
  const seen = engine(on)
  await seedInspector($, seen, 'Just find the retry logic.')
  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'brief')
    expect(await pane.find({ type: 'Text', text: '📄 Brief' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'Just find the retry logic.' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '🎯 Goal' })).toBeUndefined()
    await pane.unmount()
  }
})

test('a step opens to its input and output, closes on a second press, and says when it kept no input', async ($, on) => {
  const seen = engine(on)
  await seedInspector($, seen)

  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'steps')
    // Every kept call is a row: its mark, its time, its tool and its target.
    expect((await pane.find({ key: 'orchestrator-step-1' }))?.props.label).toMatch(/^▸ ✓ +0:02 Read +src\/big\.ts$/)
    expect((await pane.find({ key: 'orchestrator-step-3' }))?.props.label).toMatch(/^▸ ✗ .* Bash +false$/)
    if (surface === 'desktop') expect((await svgAlts(pane)).some(a => /^Timeline of 4 tool calls/.test(a))).toBe(true)
    // Input and output are wrapped text in the pane, never a Code block that scrolls inside itself.
    const input = () => pane.find({ type: 'Text', text: /^\{[\s\S]*\}$/ })
    expect(await input()).toBeUndefined()

    await pane.press({ key: 'orchestrator-step-1' })
    expect((await pane.find({ key: 'orchestrator-step-1' }))?.props.label).toMatch(/^▾ /)
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
    expect(JSON.parse(String((await input())?.text))).toEqual({ file_path: '/repo/src/big.ts' })
    expect(await pane.find({ type: 'Text', text: 'Input' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Output' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'x'.repeat(200) })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '#1 Read' })).toBeDefined()

    // Another press opens that one instead; the failed one marks its output.
    await pane.press({ key: 'orchestrator-step-3' })
    expect(await pane.find({ type: 'Text', text: '#1 Read' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '#3 Bash' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' FAILED ' })).toBeDefined()
    expect(JSON.parse(String((await input())?.text))).toEqual({ command: 'false' })
    await pane.press({ key: 'orchestrator-step-3' })
    expect(await input()).toBeUndefined()
    await pane.unmount()
  }
})

test('a step an older agent kept has no input to show, and another agent starts with none open', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  // Sixteen agents: the first no longer keeps each call's input and output.
  for (let i = 1; i <= 16; i++) {
    await spawn($, 'orchestrator:scout', { name: `scout-${i}`, prompt: `Goal ${i}` })
    await $.tool.call({ tool: 'Read' as const, file_path: `/repo/f${i}.ts`, agentId: `agent-${i}` })
  }
  expect(seen.requested).toBe(0)
  // The rest finish, so the first is the one running row the list opens with.
  for (let i = 2; i <= 16; i++) await finish($, `agent-${i}`, '', 1_000)
  await openList($)

  for (const surface of SURFACES) {
    const lean = await showAgent($, 'agent-1', surface, 80, 'steps')
    await lean.press({ key: 'orchestrator-step-1' })
    expect(await lean.find({ type: 'Text', text: 'Input not kept' })).toBeDefined()
    expect(await lean.find({ type: 'Text', text: 'Output not kept' })).toBeDefined()
    await lean.unmount()

    // The step open on one agent is not open on the next.
    const other = await showAgent($, 'agent-16', surface, 80, 'steps')
    expect((await other.find({ key: 'orchestrator-step-1' }))?.props.label).toMatch(/^▸ /)
    expect(await other.find({ type: 'Text', text: /^\{[\s\S]*\}$/ })).toBeUndefined()
    await other.unmount()
  }
})

test('the tokens tab shows how the context grew: the chart, the numbers, the biggest jumps and the requests over budget', async ($, on) => {
  const seen = engine(on)
  await seedInspector($, seen)

  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'tokens')
    const text = async (t: string | RegExp) => expect(await pane.find({ type: 'Text', text: t })).toBeDefined()
    await text(/^\s*160K$/)
    await text('peak context · 107% of 150K')
    await text('now · 107% of 150K')
    await text(/^\s*4$/)
    await text(/^\s*1K$/)
    await text('output tokens')
    await text(/^\s*265K$/)
    await text('prompt tokens processed')
    await text(/^\s*92%$/)
    await text('cache hit rate')
    await text(/^\s*\+46\.7K$/)
    await text('average growth per request')
    // The jumps, biggest first, with the calls that came between.
    const jumps = (await pane.findAll({ type: 'Text', text: /^\+\d+(\.\d)?K$/ })).map(t => t.text).filter(t => t !== '+46.7K')
    expect(jumps).toEqual(['+115K', '+20K', '+5K'])
    await text('request #4 → 160K')
    await text('after Edit src/auth.ts')
    await text('after Read src/big.ts')
    await text(/after Grep "retry" in src, Bash false/)
    await text('Over the 150K budget: request #4')
    if (surface === 'desktop') expect((await svgAlts(pane)).filter(a => a.startsWith('Context per request'))).toEqual(['Context per request: 4 requests, peak 160K of 150K, now 160K'])
    else await text(/^[▁▂▃▄▅▆▇█]+$/)
    await pane.unmount()
  }
})

// The engine draws the pane again on every scroll step: a chart whose source changed is
// a new frame on desktop, which reloads, flickers and moves the pane under the wheel.
async function chartsHold($: Engine, seen: ReturnType<typeof engine>, tabs: string[]) {
  const sources = async (tab: string) => {
    const pane = await showAgent($, 'agent-1', 'desktop', 80, tab)
    const all = (await pane.findAll({ type: 'Svg' })).map(s => String(s.props.source))
    await pane.unmount()
    return all
  }
  for (const tab of tabs) {
    const before = await sources(tab)
    expect(before.length).toBeGreaterThan(0)
    // No chart animates in: a redraw would play it again.
    for (const svg of before) expect(svg).not.toContain('@keyframes')
    await seen.clock.advance(1_000)
    expect(await sources(tab)).toEqual(before)
  }
}

test('a redraw of a running agent keeps its charts the same, though the clock moved', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-live' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', agentId: 'agent-1' } as never)
  await openList($)
  await chartsHold($, seen, ['overview', 'steps'])
})

test('a redraw of a finished agent keeps every chart the same', async ($, on) => {
  const seen = engine(on)
  await seedInspector($, seen)
  await chartsHold($, seen, ['overview', 'steps', 'tokens'])
})

test('an agent with no steps, requests or report says so on every tab, on every surface', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-quiet', prompt: 'Goal: wait' })
  await openList($)

  for (const surface of SURFACES) {
    const says = async (tab: string, text: string | RegExp, type = 'Text') => {
      const pane = await showAgent($, 'agent-1', surface, 80, tab)
      expect(await pane.find({ type, text } as never)).toBeDefined()
      if (tab === 'overview') {
        expect(await pane.find({ type: 'Text', text: ' RUNNING ' })).toBeDefined()
        if (surface === 'desktop') expect(await pane.find({ type: 'Text', text: 'context not recorded' })).toBeDefined()
      }
      await pane.unmount()
    }
    await says('overview', '● Working')
    await says('brief', 'wait', 'Markdown')
    await says('steps', 'No tool calls yet.')
    await says('tokens', /^No requests recorded/)
    await says('report', 'No report.'.replace('No report.', '● Working'))
  }
})

test('the report tab splits the report, puts open points first when partial, and shows the raw report on a press', async ($, on) => {
  engine(on, { models: { 'orchestrator:scout': 'claude-haiku-5-5' } })
  await run($, 'on')
  await spawn($, 'orchestrator:scout', { name: 'scout-half' })
  const text = 'STATUS: partial\nANSWER: half of it\nEVIDENCE: a.ts:1\nCHANGES: a.ts: x\nOPEN: the rest'
  await finish($, 'agent-1', text, 5_000)
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'report')
    const order = (await pane.findAll({ type: 'Text', text: /^(✎ Changes|⌕ Evidence|⚑ Open questions & risks)$/ })).map(t => t.text)
    expect(order).toEqual(['✎ Changes', '⚑ Open questions & risks', '⌕ Evidence'])
    expect(await pane.find({ type: 'Text', text: 'reported partial' })).toBeUndefined()
    // The raw report is wrapped text in the pane: a Code block scrolled inside itself and kept the wheel.
    const raw = () => pane.find({ type: 'Text', text: /^STATUS: partial\nANSWER: half of it/ })
    expect(await raw()).toBeUndefined()
    await pane.press({ key: 'orchestrator-report-raw' })
    expect(await raw()).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
    await pane.press({ key: 'orchestrator-report-raw' })
    expect(await raw()).toBeUndefined()
    await pane.unmount()
  }
})

test('control characters never reach the pane: a step with coloured output opens on both surfaces', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  await spawn($, 'orchestrator:builder', { model: 'sonnet', prompt: 'Goal: tidy\u0007 up\u001b[1m' })
  await $.tool.call({ tool: 'Bash', command: 'colored', agentId: 'agent-1' } as never)
  const step = detailsOf(seen)['agent-1']?.steps?.[0]
  expect(step?.output).toBe('red')
  await openList($)

  for (const surface of SURFACES) {
    const pane = await showAgent($, 'agent-1', surface, 80, 'steps')
    // The open step outlives a mount: open it only when it is shut.
    if (String((await pane.find({ key: 'orchestrator-step-1' }))?.props.label).startsWith('▸')) await pane.press({ key: 'orchestrator-step-1' })
    expect(await pane.find({ type: 'Text', text: 'red' })).toBeDefined()
    await pane.unmount()
  }
})

test('a result text that is no string is stored as one, a missing usage field counts as none, a path is clipped', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  await spawn($, 'orchestrator:scout')
  await $.tool.call({ tool: 'Bash', command: 'numeric', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Read' as const, file_path: `/repo/${'d/'.repeat(300)}f.ts`, agentId: 'agent-1' })
  seen.usages.push({ model: 'claude-haiku-5-5', input_tokens: 10, output_tokens: undefined, cache_read_input_tokens: undefined } as never)
  await step($, 'agent-1')
  const kept = detailsOf(seen)['agent-1']
  expect(kept?.steps?.[0]?.output).toBe('42')
  expect((kept?.steps?.[1] as { path?: string } | undefined)?.path?.length).toBeLessThanOrEqual(160)
  expect(kept?.requests).toEqual([{ at: 0, prompt: 10, cacheRead: 0, output: 0, steps: 2 }])
})

test('an agent outside the 15 newest stores no input or output from the start', async ($, on) => {
  const seen = engine(on)
  await run($, 'on')
  for (let i = 1; i <= 16; i++) await spawn($, 'orchestrator:scout')
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/a.ts', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read' as const, file_path: '/repo/a.ts', agentId: 'agent-2' })
  const all = detailsOf(seen)
  expect(all['agent-1']?.steps?.[0]).toMatchObject({ tool: 'Read', ms: 0 })
  expect(all['agent-1']?.steps?.[0]?.input).toBeUndefined()
  expect(all['agent-1']?.steps?.[0]?.output).toBeUndefined()
  expect(all['agent-2']?.steps?.[0]?.output).toBe('x'.repeat(200))
})
