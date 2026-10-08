import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Saved } from '../types'
import { ORCHESTRATOR_PROMPT, REPORT_CONTRACT, ROLES } from './prompts'

const IS_ON = { plugin: 'orchestrator', key: 'isOn' } as const
const isOn = atom(IS_ON, false)
const agents = atom({ plugin: 'orchestrator', key: 'agents' } as const, [])
const isExpanded = atom({ plugin: 'orchestrator', key: 'isExpanded' } as const, false)
const note = atom({ plugin: 'orchestrator', key: 'note' } as const, null)

const SECTION_ID = 'orchestrator:mode'
const ROLE_PREFIX = 'orchestrator:'
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
const ON_NOTE =
  'Orchestrator mode is now on for this session. From your next request, your system prompt carries the "Orchestrator mode" section. Follow it.'
const OFF_NOTE =
  'Orchestrator mode is now off. The "Orchestrator mode" section left your system prompt, so its delegation, model and report rules no longer apply. Work directly again.'
const MODEL_DENY =
  'Orchestrator mode: pass `model` (haiku or sonnet) on this Agent call. Pick it with the "Model and effort" rules in your system prompt, then call again.'
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

function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const GLYPHS: Record<AgentRun['status'], [string, string]> = {
  running: ['●', 'warning'],
  completed: ['✓', 'success'],
  failed: ['✗', 'error'],
  killed: ['■', 'inactive'],
}

// One line of the open list: who it is, its model, where it stands, how long, and what it did.
function describe(run: AgentRun, now: number): string {
  const label = run.name ?? run.description
  const type = run.type.startsWith(ROLE_PREFIX) ? run.type.slice(ROLE_PREFIX.length) : run.type
  const isRunning = run.status === 'running'
  const state = isRunning ? 'running' : run.status === 'completed' ? (run.outcome ?? 'done') : run.status
  const time = duration(run.runMs + (isRunning ? now - run.since : 0))
  const tools = `${run.tools} ${run.tools === 1 ? 'tool' : 'tools'}`
  const last = isRunning && run.lastTool !== null ? ` · ${run.lastTool}` : ''
  return `${label} · ${type} · ${run.tier} · ${state} · ${time} · ${tools}${last}`
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
      ? { text: 'Orchestrator mode is on. Claude now delegates the work to haiku and sonnet subagents and keeps its own context small.', context: [ON_NOTE] }
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
              <Box key={`orchestrator-agent-${run.id}`}>
                <Text color={color}>  {glyph} </Text>
                <Text dimColor={run.status !== 'running'}>{clip(describe(run, now), width)}</Text>
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
    if (!e.model) return { deny: MODEL_DENY }
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
    if (e.parentAgentId !== undefined) return next(e)

    // The roles carry the contract in their own prompts, and a workflow agent's
    // prompt cannot be rewritten.
    const addsContract = !isRole && e.workflow === undefined && e.isTeammate === undefined
    const result = await next(addsContract ? { ...e, prompt: `${e.prompt}\n\n${REPORT_CONTRACT}` } : e)
    if ('deny' in result && result.deny !== undefined) return result

    const now = await $.clock.now()
    const run: AgentRun = {
      id: result.agentId ?? `${e.tool_use_id}:${now}`,
      name: e.name ?? (e.workflow !== undefined ? `workflow agent ${e.workflow.agentIndex}` : null),
      type: e.subagentType,
      tier: tierOf(result.model),
      description: e.description,
      status: 'running',
      outcome: null,
      startedAt: now,
      since: now,
      runMs: 0,
      tools: 0,
      lastTool: null,
    }
    await update($, agents, (list: AgentRun[]) => [...list, run].slice(-KEEP_AGENTS))
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: CHECK_DENY }))

  // A subagent's run ends: keep its time, how it ended, and the STATUS of its report.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      const outcome = /^STATUS:\s*([a-z]+)/im.exec(e.answer)?.[1]?.toLowerCase() ?? null
      await changeRun($, e.agentId, run =>
        run.status === 'running' ? { ...run, status, outcome, runMs: run.runMs + e.durationMs } : run,
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A subagent's tool call is counted, and marks the agent running again when a
  // follow-up message woke it. A large direct result costs the orchestrator its
  // own context: say how much.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const tool = String(e.tool)
      await changeRun($, e.agentId, (run, now) => ({
        ...run,
        ...(run.status === 'running' ? {} : { status: 'running' as const, outcome: null, since: now }),
        tools: run.tools + 1,
        lastTool: tool,
      }))
      return next(e)
    }
    if (!READ_TOOLS.has(String(e.tool)) || !(await read($, isOn))) return next(e)
    const result = await next(e)
    if (result.text === undefined || result.text.length < BIG_RESULT_CHARS) return result

    const tokens = Math.round(result.text.length / 400) * 100
    const note = `Orchestrator mode: that ${String(e.tool)} result put about ${tokens} tokens into your context. Hand reads and commands of this size to a scout.`
    return { ...result, context: [...(result.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}
