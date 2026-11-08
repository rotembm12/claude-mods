import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentDetails, AgentRequest, AgentRun, AgentStep, Saved } from '../types'
import { clean, clip, GLYPHS, labelOf, ROLE_PREFIX, statusOf, stateOf, timeOf, toolsOf, typeOf } from './format'
import { renderPane } from './pane'
import { CONTEXT_BUDGET, MODELS, ORCHESTRATOR_PROMPT, REPORT_CONTRACT, ROLES } from './prompts'

const IS_ON = { plugin: 'orchestrator', key: 'isOn' } as const
const isOn = atom(IS_ON, false)
const agents = atom({ plugin: 'orchestrator', key: 'agents' } as const, [])
const isExpanded = atom({ plugin: 'orchestrator', key: 'isExpanded' } as const, false)
const note = atom({ plugin: 'orchestrator', key: 'note' } as const, null)
const selected = atom({ plugin: 'orchestrator', key: 'selected' } as const, null)
// The brief and report of each listed agent, apart from `agents`, which every
// subagent tool call rewrites and the band reads on each redraw.
const details = atom({ plugin: 'orchestrator', key: 'details' } as const, {})
// The step the details pane has open: another agent starts with none.
const openStep = atom({ plugin: 'orchestrator', key: 'openStep' } as const, null)

const SECTION_ID = 'orchestrator:mode'
// The pane that shows one agent: the row pressed last.
const DETAILS_PANE = 'orchestrator-agent'
// What a run keeps of its brief and its report, for the details pane.
const KEEP_BRIEF_CHARS = 20000
const KEEP_REPORT_CHARS = 12000
// The steps a run keeps, its latest, and how much of each one's target.
const KEEP_STEPS = 80
const KEEP_TARGET_CHARS = 160
// How much of a call's input and of its output a step keeps, and how many of the
// newest agents keep them at all: they are most of the state's size.
const KEEP_IO_CHARS = 600
const KEEP_IO_AGENTS = 15
// The model requests a run keeps, its latest.
const KEEP_REQUESTS = 150
const STORE_KEY = 'sessions'
const KEEP_SESSIONS = 100
const KEEP_AGENTS = 50
// The tiers a model id can name, in the order the band lists them.
const TIERS = ['fable', 'opus', 'sonnet', 'haiku']
// The only tiers a subagent may run on.
const ALLOWED_TIERS = ['sonnet', 'haiku']
// The switch is two segments, off and on; the one that holds is filled.
const OFF_KEY = 'orchestrator-off'
const ON_KEY = 'orchestrator-on'
const DETAILS_KEY = 'orchestrator-details'
const OFF_FILL = '#4a4a4a'
// The track under the segment that does not hold, so the two read as one control.
const TRACK = '#262626'
// The mark, the name, and the two segments take this many cells.
const SWITCH_CELLS = 24
// The rows the open list takes at most, its "more" row included.
const MAX_LIST_ROWS = 12

// About four characters a token: a direct result past this size gets a note.
const BIG_RESULT_CHARS = 8000
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'])

const USAGE = 'Usage: /orchestrator [on|off|status]. With no argument it switches the mode.'
// A system prompt can be composed once per thread, so a mode switched on mid-session
// may never reach it: the note carries the rules whole.
const ON_NOTE = `Orchestrator mode is now on for this session. Its rules follow. Follow them from this request on. An "Orchestrator mode" section in your system prompt, if there is one, is the same text.

${ORCHESTRATOR_PROMPT}`
const OFF_NOTE =
  'Orchestrator mode is now off. Its rules (the ones the note that turned it on carried, and any "Orchestrator mode" section in your system prompt) no longer apply: their delegation, model and report rules are gone. Work directly again.'
const MODEL_DENY =
  'Orchestrator mode: pass `model` (haiku or sonnet) on this Agent call, or use an orchestrator role, which runs on its own model. Pick it with the "Model and effort" rules in your system prompt, then call again.'
const TIER_DENY =
  'Orchestrator mode: subagents run on haiku or sonnet only, never opus or fable. Use haiku for repetitive, simple tasks and sonnet for hard or long ones, then call again.'
const FORK_DENY =
  'Orchestrator mode: forks are refused, because a fork runs on your own model. Spawn a haiku or sonnet agent with a brief that carries what it needs.'
const SPAWN_DENY =
  'Orchestrator mode: every subagent runs on haiku or sonnet. Give this agent `model: "haiku"` or `model: "sonnet"` (in a workflow script, in the options of its agent() call).'
const DEPTH_DENY =
  'Orchestrator mode: only the orchestrator spawns agents. Do this part yourself, or end with STATUS: blocked and say which extra agent you need.'
const CHECK_DENY = 'Orchestrator mode could not check this spawn. Call it again.'

function tierOf(model: string): string {
  const id = model.toLowerCase()
  return TIERS.find(t => id.includes(t)) ?? model
}

const isAllowed = (model: string) => ALLOWED_TIERS.includes(tierOf(model))

// An allowed model runs as the pinned model of its tier, whatever name it came with:
// the tier alone the Agent tool passes, or a version a script or teammate names.
function pin(model: string): string {
  const tier = tierOf(model)
  return tier === 'haiku' || tier === 'sonnet' ? MODELS[tier] : model
}

function parse(args: string, current: boolean): boolean | 'status' | null {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'toggle') return !current
  if (word === 'on') return true
  if (word === 'off') return false
  if (word === 'status') return 'status'
  return null
}

function ledger(runs: AgentRun[]): string[] {
  const counts: Record<string, number> = {}
  for (const run of runs) counts[run.tier] = (counts[run.tier] ?? 0) + 1
  const rank = (tier: string) => (TIERS.includes(tier) ? TIERS.indexOf(tier) : TIERS.length)
  return Object.entries(counts)
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([tier, n]) => `${n} ${tier}`)
}

// One line of the open list: who it is, its model, where it stands, how long, and what it did.
function describe(run: AgentRun, now: number): string {
  const last = run.status === 'running' && run.lastTool !== null ? ` · ${run.lastTool}` : ''
  return `${labelOf(run)} · ${typeOf(run)} · ${run.tier} · ${stateOf(run)} · ${timeOf(run, now)} · ${toolsOf(run)}${last}`
}

const keep = (text: string, chars: number) => {
  const plain = clean(text)
  return plain.length <= chars ? plain : `${plain.slice(0, chars)}\n… (${plain.length - chars} more characters)`
}
// A token count as the API reported it; a field it left out is none.
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

// The keys a tool call carries that are no argument of the tool's.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])
const textOf = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const firstLine = (text: string) => text.split('\n')[0] ?? ''

function relative(path: string, cwd: string): string {
  if (cwd !== '' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  const parts = path.split('/')
  return path.startsWith('/') && parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : path
}

// What a call acted on, in a few words, and the file when it names one.
function targetOf(tool: string, input: Record<string, unknown>, cwd: string): { target: string; path?: string } {
  const file = textOf(input.file_path) ?? textOf(input.notebook_path)
  if (file !== undefined) {
    const path = relative(file, cwd)
    const offset = typeof input.offset === 'number' ? input.offset : undefined
    const limit = typeof input.limit === 'number' ? input.limit : undefined
    const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit}` : ''}` : limit !== undefined ? `:1-${limit}` : ''
    return { target: `${path}${range}`, path }
  }
  const pattern = textOf(input.pattern)
  if (pattern !== undefined) {
    const where = textOf(input.path) ?? textOf(input.glob)
    const shown = tool === 'Grep' ? `"${pattern}"` : pattern
    return { target: where !== undefined ? `${shown} in ${relative(where, cwd)}` : shown }
  }
  const query = textOf(input.query)
  if (query !== undefined) return { target: `"${firstLine(query)}"` }
  const named = textOf(input.command) ?? textOf(input.url) ?? textOf(input.description) ?? textOf(input.skill) ?? textOf(input.prompt)
  if (named !== undefined) return { target: firstLine(named) }
  const other = Object.entries(input).find(([key, value]) => !RESERVED.has(key) && textOf(value) !== undefined)
  return { target: other !== undefined ? firstLine(String(other[1]).trim()) : '' }
}

// A press on a row: the details pane shows that agent, opened or retitled.
async function showAgent($: EngineInterface, run: AgentRun) {
  // Another agent has no step open yet.
  if ((await read($, selected)) !== run.id) await update($, openStep, () => null)
  await update($, selected, () => run.id)
  await $.ui.open({ id: DETAILS_PANE, title: `Agent · ${clip(labelOf(run), 40)}` })
}

// Running agents first, then the past ones, newest first.
function ordered(runs: AgentRun[]): AgentRun[] {
  const newest = [...runs].reverse()
  return [...newest.filter(r => r.status === 'running'), ...newest.filter(r => r.status !== 'running')]
}

async function loadAll($: EngineInterface): Promise<Record<string, Saved>> {
  const value = await $.store.get(STORE_KEY)
  return value !== null && typeof value === 'object' ? (value as Record<string, Saved>) : {}
}

// Kept per session id, so a resumed session comes back in the mode it left.
async function save($: EngineInterface, on: boolean) {
  const all = await loadAll($)
  all[await $.session.id()] = { isOn: on, at: await $.clock.now() }
  const newest = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP_SESSIONS)
  await $.store.set(STORE_KEY, Object.fromEntries(newest))
}

async function setMode($: EngineInterface, wanted: boolean) {
  await update($, isOn, () => wanted)
  await save($, wanted)
}

// A press has no command row to tell the model, so the note rides the person's
// next prompt. A second press before that prompt puts back what the model knows.
async function setByPress($: EngineInterface, wanted: boolean) {
  if ((await read($, isOn)) === wanted) return
  await setMode($, wanted)
  await update($, note, (pending: string | null) => (pending === null ? (wanted ? ON_NOTE : OFF_NOTE) : null))
}

// Changes the one agent the mod tracks under `id`, and writes nothing for any other.
async function changeRun($: EngineInterface, id: string, change: (run: AgentRun, now: number) => AgentRun) {
  const runs: AgentRun[] = await read($, agents)
  if (!runs.some(r => r.id === id)) return
  const now = await $.clock.now()
  await update($, agents, (list: AgentRun[]) => list.map(r => (r.id === id ? change(r, now) : r)))
}

// A call's arguments as JSON, the keys that are no argument of the tool's left out.
function inputOf(input: Record<string, unknown>): string {
  try {
    const args = Object.fromEntries(Object.entries(input).filter(([key]) => !RESERVED.has(key)))
    return keep(JSON.stringify(args, null, 2) ?? '', KEEP_IO_CHARS)
  } catch {
    return ''
  }
}

// What a call answered: the deny, else its text, else its result as JSON.
function outputOf(result: { deny?: unknown; text?: unknown; result?: unknown }): string {
  try {
    if (result.deny !== undefined) return keep(String(result.deny), KEEP_IO_CHARS)
    if (result.text !== undefined && result.text !== null) return keep(String(result.text), KEEP_IO_CHARS)
    return keep(JSON.stringify(result.result, null, 2) ?? '', KEEP_IO_CHARS)
  } catch {
    return ''
  }
}

// Adds a running step to an agent the mod keeps details of, and answers its
// number and whether it keeps the call's input and output, or null for an agent
// it keeps no details of.
async function startStep($: EngineInterface, id: string, tool: string, input: Record<string, unknown>): Promise<{ n: number; withIo: boolean } | null> {
  const runs = (await read($, agents)) as AgentRun[]
  const run = runs.find(r => r.id === id)
  if (run === undefined) return null
  const withIo = runs.slice(-KEEP_IO_AGENTS).some(r => r.id === id)
  const cwd = await $.session.cwd().catch(() => '')
  const now = await $.clock.now()
  const { target, path } = targetOf(tool, input, cwd)
  let n: number | null = null
  await update($, details, (all: Record<string, AgentDetails>) => {
    const kept = all[id]
    if (kept === undefined) return all
    const steps = kept.steps ?? []
    n = (steps.at(-1)?.n ?? 0) + 1
    const step: AgentStep = {
      n,
      tool: clean(tool),
      target: clip(clean(target), KEEP_TARGET_CHARS),
      ...(path !== undefined ? { path: clip(clean(path), KEEP_TARGET_CHARS) } : {}),
      at: now - run.startedAt,
      ms: null,
      isError: false,
      ...(withIo ? { input: inputOf(input) } : {}),
    }
    return { ...all, [id]: { ...kept, steps: [...steps, step].slice(-KEEP_STEPS) } }
  })
  return n === null ? null : { n, withIo }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'orchestrator', description: 'Turn orchestrator mode on or off for this session', argumentHint: '[on|off|status]' })
    for (const role of ROLES) await $.agent.register(role)

    // A reload fires session.start again, and $.state still holds the mode then.
    if ((await $.state.get(IS_ON)).version === 0) {
      const saved = (await loadAll($))[await $.session.id()]
      if (saved?.isOn) await update($, isOn, () => true)
    }
    return result
  })

  on('command.run', { command: 'orchestrator' }, async ($, e) => {
    const current = await read($, isOn)
    const wanted = parse(e.args, current)
    if (wanted === null) return { text: USAGE }

    if (wanted === 'status') {
      const runs: AgentRun[] = await read($, agents)
      const running = runs.filter(r => r.status === 'running').length
      const started = runs.length > 0 ? ` Agents started while on: ${ledger(runs).join(', ')}.` : ''
      const still = running > 0 ? ` ${running} still running.` : ''
      return { text: `Orchestrator mode is ${current ? 'on' : 'off'}.${started}${still}` }
    }
    if (wanted === current) return { text: `Orchestrator mode is already ${current ? 'on' : 'off'}.` }

    await setMode($, wanted)
    // The command's own context tells the model, so no press note waits.
    await update($, note, () => null)
    return wanted
      ? { text: 'Orchestrator mode is on. Claude now delegates the work to Haiku 5.5 and Sonnet 5.5 subagents and keeps its own context small.', context: [ON_NOTE] }
      : { text: 'Orchestrator mode is off.', context: [OFF_NOTE] }
  })

  // The switch: one row above the prompt, drawn over whatever the other plugins drew there.
  // Its details button opens the list of the agents under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const isOnNow = await read($, isOn)
    const runs: AgentRun[] = await read($, agents)
    const isOpen = runs.length > 0 && (await read($, isExpanded))
    const running = runs.filter(r => r.status === 'running').length
    const summary = [...(running > 0 ? [`${running} running`] : []), ...ledger(runs)]
    const detail = isOnNow
      ? `delegating · ${summary.length > 0 ? summary.join(' · ') : 'no agents yet'}`
      : 'Claude works directly'
    const toggle = `${isOpen ? '▾' : '▸'} details`
    const room = e.props.bodyColumns - SWITCH_CELLS - (runs.length > 0 ? toggle.length + 2 : 0) - 2

    // The terminal draws the two segments as one filled control. Every other
    // surface draws native buttons, so the segment that holds is the primary one.
    const offSegment = e.surface !== 'terminal' ? (
      <Button key={OFF_KEY} variant={isOnNow ? 'secondary' : 'primary'} label="off" onPress={() => setByPress($, false)} />
    ) : isOnNow ? (
      <Box backgroundColor={TRACK}>
        <Button key={OFF_KEY} plain dimColor label=" off " onPress={() => setByPress($, false)} />
      </Box>
    ) : (
      <Box backgroundColor={OFF_FILL}>
        <Button key={OFF_KEY} plain label=" off " onPress={() => setByPress($, false)} />
      </Box>
    )
    const onSegment = e.surface !== 'terminal' ? (
      <Button key={ON_KEY} variant={isOnNow ? 'primary' : 'secondary'} label="on" onPress={() => setByPress($, true)} />
    ) : isOnNow ? (
      <Box backgroundColor="success">
        <Button key={ON_KEY} plain label=" on " onPress={() => setByPress($, true)} />
      </Box>
    ) : (
      <Box backgroundColor={TRACK}>
        <Button key={ON_KEY} plain dimColor label=" on " onPress={() => setByPress($, true)} />
      </Box>
    )
    const row = (
      <Box>
        {isOnNow ? <Text color="success">◆ </Text> : <Text color="inactive">◇ </Text>}
        {isOnNow ? (
          <Text color="success" bold>
            orchestrator
          </Text>
        ) : (
          <Text dimColor>orchestrator</Text>
        )}
        <Text> </Text>
        {offSegment}
        {onSegment}
        {runs.length > 0 && <Text>  </Text>}
        {runs.length > 0 && <Button key={DETAILS_KEY} plain label={toggle} onPress={() => update($, isExpanded, (open: boolean) => !open)} />}
        {room > 0 && <Text dimColor>  {clip(detail, room)}</Text>}
      </Box>
    )

    let band = row
    if (isOpen) {
      const now = await $.clock.now()
      const all = ordered(runs)
      const fits = Math.max(1, Math.min(MAX_LIST_ROWS, e.props.maxRows - 1))
      const shown = all.length > fits ? all.slice(0, fits - 1) : all
      const width = e.props.bodyColumns - 4
      band = (
        <Box flexDirection="column">
          {row}
          {shown.map(run => {
            const [glyph, color] = GLYPHS[run.status]
            return (
              <Box key={`orchestrator-row-${run.id}`}>
                <Text color={color}>  {glyph} </Text>
                <Button
                  key={`orchestrator-agent-${run.id}`}
                  plain
                  dimColor={run.status !== 'running'}
                  label={clip(describe(run, now), width)}
                  onPress={() => showAgent($, run)}
                />
              </Box>
            )
          })}
          {shown.length < all.length && <Text dimColor>    {all.length - shown.length} more</Text>}
        </Box>
      )
    }

    return below.type === 'engine' ? band : (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })

  // The details pane: the agent whose row was pressed last, in the inspector's tabs.
  on('ui.render', { component: 'Pane', requestId: DETAILS_PANE }, ($, e) => renderPane($, e))

  // A slash command is no prompt for the model: the note waits for one that is.
  on('prompt.submit', async ($, e, next) => {
    const pending = await read($, note)
    if (pending === null || e.text.trimStart().startsWith('/')) return next(e)
    await update($, note, () => null)
    return next({ ...e, context: [...(e.context ?? []), pending] })
  }).catch(($, e, next) => next(e))

  // A teammate's render of its lead's prompt carries no orchestrator section.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (e.traits.includes('teammate') || !(await read($, isOn))) return result
    return { sections: [...result.sections, { id: SECTION_ID, text: ORCHESTRATOR_PROMPT, scope: 'session' as const }] }
  })

  // The roles are listed only while the mode is on.
  on('agent.offer', async ($, e, next) => {
    if (!e.agent.startsWith(ROLE_PREFIX) || (await read($, isOn))) return next(e)
    return { isOffered: false }
  })

  // Every routing decision is explicit, on haiku or sonnet, and delegation stays one level deep.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (e.agentId !== undefined) return { deny: DEPTH_DENY }
    if (e.subagent_type === 'fork') return { deny: FORK_DENY }
    // A role left without a model runs on the one its own spec carries.
    if (!e.model) return e.subagent_type?.startsWith(ROLE_PREFIX) ? next(e) : { deny: MODEL_DENY }
    if (!isAllowed(e.model)) return { deny: TIER_DENY }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: CHECK_DENY }))

  // The backstop for every other way an agent starts: a workflow's agent(), a
  // teammate, another plugin's $.agent.spawn. A role with no model runs on its own.
  on('agent.spawn', async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (e.fork) return { deny: FORK_DENY }
    const isRole = e.subagentType.startsWith(ROLE_PREFIX)
    if (e.model === undefined ? !isRole : !isAllowed(e.model)) return { deny: SPAWN_DENY }
    // A role passes no model and runs on the one its own spec carries.
    const pinned = e.model === undefined ? e : { ...e, model: pin(e.model) }
    if (e.parentAgentId !== undefined) return next(pinned)

    // The roles carry the budget and the contract in their own prompts, and a
    // workflow agent's prompt cannot be rewritten.
    const addsContract = !isRole && e.workflow === undefined && e.isTeammate === undefined
    const result = await next(addsContract ? { ...pinned, prompt: `${e.prompt}\n\n${CONTEXT_BUDGET}\n\n${REPORT_CONTRACT}` } : pinned)
    if ('deny' in result && result.deny !== undefined) return result

    const now = await $.clock.now()
    const run: AgentRun = {
      id: result.agentId ?? `${e.tool_use_id}:${now}`,
      name: e.name !== undefined ? clean(e.name) : e.workflow !== undefined ? `workflow agent ${e.workflow.agentIndex}` : null,
      type: e.subagentType,
      tier: tierOf(result.model),
      description: clean(e.description),
      status: 'running',
      outcome: null,
      startedAt: now,
      since: now,
      runMs: 0,
      tools: 0,
      lastTool: null,
      model: result.model,
    }
    const listed: AgentRun[] = await update($, agents, (list: AgentRun[]) => [...list, run].slice(-KEEP_AGENTS))
    // Details go with their agent when it leaves the list.
    const ids = new Set(listed.map(r => r.id))
    // Only the newest agents keep each call's input and output.
    const withIo = new Set(listed.slice(-KEEP_IO_AGENTS).map(r => r.id))
    const lean = (d: AgentDetails): AgentDetails => ({
      ...d,
      ...(d.steps !== undefined ? { steps: d.steps.map(({ input: _input, output: _output, ...step }) => step) } : {}),
    })
    await update($, details, (all: Record<string, AgentDetails>) => ({
      ...Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)).map(([id, d]) => [id, withIo.has(id) ? d : lean(d)])),
      [run.id]: { brief: keep(e.prompt, KEEP_BRIEF_CHARS), report: null },
    }))
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: CHECK_DENY }))

  // A subagent's run ends: keep its time, how it ended, and the STATUS of its report.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      const outcome = statusOf(e.answer) ?? null
      await changeRun($, e.agentId, run =>
        run.status === 'running'
          ? { ...run, status, outcome, runMs: run.runMs + e.durationMs }
          : // A follow-up answered with no tool call never marked the agent running again.
            run.status === 'completed' && e.reason === 'answer'
            ? { ...run, outcome: outcome ?? run.outcome, runMs: run.runMs + e.durationMs }
            : run,
      )
      const report = e.answer.trim()
      const id = e.agentId
      if (report !== '') {
        await update($, details, (all: Record<string, AgentDetails>) =>
          all[id] === undefined ? all : { ...all, [id]: { ...all[id], report: keep(report, KEEP_REPORT_CHARS) } },
        )
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A subagent's model request: what it cost, as the API reported it. The request
  // is the engine's; the hook only reads the response and returns it.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const response = yield* next(e)
    if (id === undefined || !response.usage) return response
    // The request is answered however this goes: nothing below may call next again.
    try {
      const run = ((await read($, agents)) as AgentRun[]).find(r => r.id === id)
      if (run === undefined) return response
      const now = await $.clock.now()
      const usage = response.usage
      const cacheRead = count(usage.cache_read_input_tokens)
      await update($, details, (all: Record<string, AgentDetails>) => {
        const kept = all[id]
        if (kept === undefined) return all
        const request: AgentRequest = {
          at: now - run.startedAt,
          prompt: count(usage.input_tokens) + cacheRead + count(usage.cache_creation_input_tokens),
          cacheRead,
          output: count(usage.output_tokens),
          steps: kept.steps?.at(-1)?.n ?? 0,
        }
        return { ...all, [id]: { ...kept, requests: [...(kept.requests ?? []), request].slice(-KEEP_REQUESTS) } }
      })
    } catch {
      // Not recording a request costs nothing.
    }
    return response
  })

  // A subagent's tool call is counted, and marks the agent running again when a
  // follow-up message woke it. A large direct result costs the orchestrator its
  // own context: say how much.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const tool = String(e.tool)
      const id = e.agentId
      await changeRun($, id, (run, now) => ({
        ...run,
        ...(run.status === 'running' ? {} : { status: 'running' as const, outcome: null, since: now }),
        tools: run.tools + 1,
        lastTool: tool,
      }))
      const begun = await startStep($, id, tool, e as unknown as Record<string, unknown>)
      if (begun === null) return next(e)
      const { n, withIo } = begun
      const started = await $.clock.now()
      const result = await next(e)
      const ms = (await $.clock.now()) - started
      const isError = ('deny' in result && result.deny !== undefined) || result.isError === true
      const output = withIo ? outputOf(result as { deny?: unknown; text?: unknown; result?: unknown }) : undefined
      await update($, details, (all: Record<string, AgentDetails>) => {
        const kept = all[id]
        if (kept?.steps === undefined) return all
        return { ...all, [id]: { ...kept, steps: kept.steps.map(s => (s.n === n ? { ...s, ms, isError, ...(output !== undefined ? { output } : {}) } : s)) } }
      })
      return result
    }
    if (!READ_TOOLS.has(String(e.tool)) || !(await read($, isOn))) return next(e)
    const result = await next(e)
    if (result.text === undefined || result.text.length < BIG_RESULT_CHARS) return result

    const tokens = Math.round(result.text.length / 400) * 100
    const note = `Orchestrator mode: that ${String(e.tool)} result put about ${tokens} tokens into your context. Hand reads and commands of this size to a scout.`
    return { ...result, context: [...(result.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}
