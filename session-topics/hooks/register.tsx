import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Saved } from '../types'

const topics = atom({ plugin: 'session-topics', key: 'topics' } as const, [])
const seed = atom({ plugin: 'session-topics', key: 'seed' } as const, null)
const isMinimized = atom({ plugin: 'session-topics', key: 'isMinimized' } as const, false)

const STORE_KEY = 'recent'
const KEEP_SESSIONS = 50
const MAX_TOPICS = 5
const MINI_WIDTH = 24
const RESUME_MESSAGES = 8

// Readable on a dark or a light theme. Each session gets one, picked by its id,
// so two sessions on the same subject still look different.
const PALETTE = ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66', '#ff79c6']

const SYSTEM = `You keep a short list of the topics a person worked on in one Claude Code session. The list helps them tell several terminals apart at a glance.

Rules:
- Each topic is 1 to 4 words and names the concrete subject (a feature, file, bug, page or tool). No trailing punctuation.
- Keep the existing topics, in order. If the new messages continue the latest topic, you may sharpen its wording.
- Add a topic at the end only when the messages start a clearly different subject.
- Keep at most ${MAX_TOPICS} topics. Past that, merge the oldest two.
- Messages with no subject ("yes", "continue", "thanks") leave the list as it is.
- Write each topic in English, whatever language the messages use.

Reply with the JSON array of strings only, oldest topic first.`

function colorFor(id: string): string {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return PALETTE[(hash >>> 0) % PALETTE.length] ?? '#61afef'
}

function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

// A slash command counts by its arguments alone: `/goal build X` is about X.
// The desktop puts a system reminder in front of the first prompt; it is no topic.
function subjectOf(text: string): string {
  const trimmed = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return trimmed.startsWith('/') ? trimmed.replace(/^\/\S*\s*/, '').trim() : trimmed
}

function seedOf(subject: string): string {
  return clip(subject.split(/\s+/).slice(0, 6).join(' '), 40)
}

function parseTopics(reply: string): string[] | null {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(reply.slice(start, end + 1))
    if (!Array.isArray(value)) return null
    const list = value
      .filter((t): t is string => typeof t === 'string')
      .map(t => clip(t.trim().replace(/[.!]+$/, ''), 40))
      .filter(t => t.length > 0)
      .slice(-MAX_TOPICS)
    return list.length > 0 ? list : null
  } catch {
    return null
  }
}

async function ask($: EngineInterface, current: string[], messages: string[]): Promise<string[] | null> {
  const prompt = [
    `Topics so far, oldest first: ${JSON.stringify(current)}`,
    'Newest messages from the person, oldest first:',
    ...messages.map(m => `<message>\n${m.slice(0, 1500)}\n</message>`),
    'Reply with the updated JSON array.',
  ].join('\n\n')
  const reply = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 200, timeoutMs: 30_000 })
  return reply.isAnswered ? parseTopics(reply.text) : null
}

async function loadAll($: EngineInterface): Promise<Record<string, Saved>> {
  const value = await $.store.get(STORE_KEY)
  return value !== null && typeof value === 'object' ? (value as Record<string, Saved>) : {}
}

// Kept per session id, so a resumed session shows its topics with no model call.
async function save($: EngineInterface, list: string[]) {
  const all = await loadAll($)
  all[await $.session.id()] = { topics: list, at: await $.clock.now() }
  const newest = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP_SESSIONS)
  await $.store.set(STORE_KEY, Object.fromEntries(newest))
}

// Module variables: a reload drops them, and the topics in $.state stay.
let queue: string[] = []
let isBusy = false
let generation = 0

async function drain($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    while (queue.length > 0) {
      const started = generation
      const batch = queue.splice(0, queue.length)
      const list = await ask($, await read($, topics), batch)
      // A /clear while the model answered: that answer is about the old session.
      if (list && started === generation) {
        await update($, topics, () => list)
        await save($, list)
      }
    }
  } catch {
    // A failed call leaves the topics as they were; the next prompt tries again.
  } finally {
    isBusy = false
  }
}

// The model call runs on a timer of its own, so no prompt waits for it.
function enqueue($: EngineInterface, messages: string[]) {
  queue.push(...messages)
  $.clock.after(0, () => void drain($))
}

async function reset($: EngineInterface) {
  generation += 1
  queue = []
  await update($, topics, () => [])
  await update($, seed, () => null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // A reload fires session.start again; the session's topics are still in $.state.
    if ((await read($, topics)).length > 0) return result

    const saved = (await loadAll($))[await $.session.id()]
    if (saved && saved.topics.length > 0) {
      await update($, topics, () => saved.topics)
      return result
    }

    const earlier = (await $.session.messages())
      .filter(m => m.role === 'user' && !m.text.trimStart().startsWith('<'))
      .map(m => subjectOf(m.text))
      .filter(s => s.length > 0)
    if (earlier.length > 0) enqueue($, earlier.slice(-RESUME_MESSAGES))

    return result
  })

  // Only what the person typed: a plugin's or a peer's prompt is no topic of theirs.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const subject = subjectOf(e.text)
      if (subject.length > 0) {
        if ((await read($, seed)) === null) await update($, seed, () => seedOf(subject))
        enqueue($, [subject])
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // No session.start follows a /clear, so the list starts over here.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reset($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // What other plugins drew in the band: drawn under this row, never replaced.
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, topics)
    const first = await read($, seed)
    const minimized = await read($, isMinimized)
    const color = colorFor(await $.session.id())

    const hasTopics = list.length > 0
    const current = list[list.length - 1] ?? first ?? 'new session'
    const earlier = list.slice(0, -1).reverse().join(' · ')

    // The toggle, the dot and their spaces take four cells.
    const room = e.props.bodyColumns - 4
    const head = clip(current, minimized ? Math.min(MINI_WIDTH, room) : room)
    const tail = minimized || earlier.length === 0 ? '' : clip(` · ${earlier}`, room - head.length)

    const row = (
      <Box>
        <Button
          key="topics-toggle"
          plain
          dimColor
          label={minimized ? '▸' : '▾'}
          onPress={() => update($, isMinimized, v => !v)}
        />
        <Text color={color}> ● </Text>
        <Text color={color} bold={hasTopics} dimColor={!hasTopics}>
          {head}
        </Text>
        {tail.length > 0 && <Text dimColor>{tail}</Text>}
      </Box>
    )

    return below.type === 'engine' ? row : (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
