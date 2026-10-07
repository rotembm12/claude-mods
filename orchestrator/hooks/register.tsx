import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Saved } from '../types'
import { ORCHESTRATOR_PROMPT, REPORT_CONTRACT, ROLES } from './prompts'

const IS_ON = { plugin: 'orchestrator', key: 'isOn' } as const
const isOn = atom(IS_ON, false)
const spawns = atom({ plugin: 'orchestrator', key: 'spawns' } as const, {})
const note = atom({ plugin: 'orchestrator', key: 'note' } as const, null)

const SECTION_ID = 'orchestrator:mode'
const ROLE_PREFIX = 'orchestrator:'
const STORE_KEY = 'sessions'
const KEEP_SESSIONS = 100
const TIERS = ['fable', 'opus', 'sonnet', 'haiku', 'fork']
// The switch is two segments, off and on; the one that holds is filled.
const OFF_KEY = 'orchestrator-off'
const ON_KEY = 'orchestrator-on'
const OFF_FILL = '#4a4a4a'
// The track under the segment that does not hold, so the two read as one control.
const TRACK = '#262626'

// About four characters a token: a direct result past this size gets a note.
const BIG_RESULT_CHARS = 8000
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'])

const USAGE = 'Usage: /orchestrator [on|off|status]. With no argument it switches the mode.'
const ON_NOTE =
  'Orchestrator mode is now on for this session. From your next request, your system prompt carries the "Orchestrator mode" section. Follow it.'
const OFF_NOTE =
  'Orchestrator mode is now off. The "Orchestrator mode" section left your system prompt, so its delegation, model and report rules no longer apply. Work directly again.'
const MODEL_DENY =
  'Orchestrator mode: pass `model` (haiku, sonnet, opus or fable) on this Agent call. Pick it with the "Model and effort" rules in your system prompt, then call again.'
const DEPTH_DENY =
  'Orchestrator mode: only the orchestrator spawns agents. Do this part yourself, or end with STATUS: blocked and say which extra agent you need.'

function tierOf(model: string): string {
  const id = model.toLowerCase()
  return TIERS.find(t => id.includes(t)) ?? model
}

function parse(args: string, current: boolean): boolean | 'status' | null {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'toggle') return !current
  if (word === 'on') return true
  if (word === 'off') return false
  if (word === 'status') return 'status'
  return null
}

async function ledger($: EngineInterface): Promise<string[]> {
  const counts: Record<string, number> = await read($, spawns)
  const rank = (tier: string) => (TIERS.includes(tier) ? TIERS.indexOf(tier) : TIERS.length)
  return Object.entries(counts)
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([tier, n]) => `${n} ${tier}`)
}

function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
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
  if (wanted) await update($, spawns, () => ({}))
  await save($, wanted)
}

// A press has no command row to tell the model, so the note rides the person's
// next prompt. A second press before that prompt puts back what the model knows.
async function setByPress($: EngineInterface, wanted: boolean) {
  if ((await read($, isOn)) === wanted) return
  await setMode($, wanted)
  await update($, note, (pending: string | null) => (pending === null ? (wanted ? ON_NOTE : OFF_NOTE) : null))
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
      const counts = await ledger($)
      const agents = counts.length > 0 ? ` Agents started while on: ${counts.join(', ')}.` : ''
      return { text: `Orchestrator mode is ${current ? 'on' : 'off'}.${agents}` }
    }
    if (wanted === current) return { text: `Orchestrator mode is already ${current ? 'on' : 'off'}.` }

    await setMode($, wanted)
    // The command's own context tells the model, so no press note waits.
    await update($, note, () => null)
    return wanted
      ? { text: 'Orchestrator mode is on. Claude now delegates the work to subagents and keeps its own context small.', context: [ON_NOTE] }
      : { text: 'Orchestrator mode is off.', context: [OFF_NOTE] }
  })

  // The switch: one row above the prompt, drawn over whatever the other plugins drew there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const isOnNow = await read($, isOn)
    const counts = await ledger($)
    const detail = isOnNow
      ? `delegating · ${counts.length > 0 ? counts.join(' · ') : 'no agents yet'}`
      : 'Claude works directly'
    // The mark, the name, and the two segments take this many cells.
    const room = e.props.bodyColumns - 24

    const offSegment = isOnNow ? (
      <Box backgroundColor={TRACK}>
        <Button key={OFF_KEY} plain dimColor label=" off " onPress={() => setByPress($, false)} />
      </Box>
    ) : (
      <Box backgroundColor={OFF_FILL}>
        <Button key={OFF_KEY} plain label=" off " onPress={() => setByPress($, false)} />
      </Box>
    )
    const onSegment = isOnNow ? (
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
        {room > 0 && <Text dimColor>  {clip(detail, room)}</Text>}
      </Box>
    )

    return below.type === 'engine' ? row : (
      <Box flexDirection="column">
        {row}
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

  // Every routing decision is explicit, and delegation stays one level deep.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (e.agentId !== undefined) return { deny: DEPTH_DENY }
    if (e.subagent_type !== 'fork' && !e.model) return { deny: MODEL_DENY }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.parentAgentId !== undefined || !(await read($, isOn))) return next(e)

    // The roles carry the contract in their own prompts, and a workflow agent's
    // prompt cannot be rewritten.
    const addsContract = !e.subagentType.startsWith(ROLE_PREFIX) && e.workflow === undefined && e.isTeammate === undefined
    const result = await next(addsContract ? { ...e, prompt: `${e.prompt}\n\n${REPORT_CONTRACT}` } : e)
    if ('deny' in result && result.deny !== undefined) return result

    const tier = e.fork ? 'fork' : tierOf(result.model)
    await update($, spawns, (counts: Record<string, number>) => ({ ...counts, [tier]: (counts[tier] ?? 0) + 1 }))
    return result
  }).catch(($, e, next) => next(e))

  // A large direct result costs the orchestrator its own context: say how much.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || !READ_TOOLS.has(String(e.tool)) || !(await read($, isOn))) return next(e)
    const result = await next(e)
    if (result.text === undefined || result.text.length < BIG_RESULT_CHARS) return result

    const tokens = Math.round(result.text.length / 400) * 100
    const note = `Orchestrator mode: that ${String(e.tool)} result put about ${tokens} tokens into your context. Hand reads and commands of this size to a scout.`
    return { ...result, context: [...(result.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}
