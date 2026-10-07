import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PLUGIN = 'session-topics'

const band = (hasSurvey = false, bodyColumns = 80) =>
  ({
    component: 'AbovePrompt',
    props: {
      hasSurvey,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  }) as const

const USAGE = {
  input_tokens: 40,
  output_tokens: 8,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

type Setup = {
  replies?: string[]
  store?: Record<string, unknown>
  messages?: SessionMessage[]
  id?: string
}

// Stand in for the engine beneath the plugin. The model answers each call
// with the next reply; `asked` holds the prompts it was sent.
function engine(on: On, setup: Setup = {}) {
  const replies = [...(setup.replies ?? [])]
  const asked: string[] = []
  const session = { id: setup.id ?? 'session-a' }
  mock.store(on, setup.store)
  const clock = mock.clock(on)
  on('session.id', () => ({ value: session.id }))
  on('session.messages', () => ({ value: setup.messages ?? [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', (_$, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: replies.shift() ?? '[]', usage: USAGE } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { asked, clock, session }
}

const type = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const userRow = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

test('the first words show at once, then the topic the model names', async ($, on) => {
  const { clock } = engine(on, { replies: ['["Login bug"]'] })
  await type($, 'Please fix the login bug in auth.ts, it throws on submit')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: 'Please fix the login bug in' })).toBeDefined()
    await ui.unmount()
  }

  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: 'Login bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Please fix/ })).toBeUndefined()
    // The band other plugins drew stays, under the row.
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('the newest topic leads and the earlier ones follow', async ($, on) => {
  const { clock } = engine(on, { replies: ['["Login bug"]', '["Login bug", "Dark mode toggle"]'] })
  await type($, 'fix the login bug')
  await clock.settle()
  await type($, 'now add a dark mode toggle to the header')
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: 'Dark mode toggle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · Login bug' })).toBeDefined()
    await ui.unmount()
  }
})

test('the toggle minimizes the row to the current topic and back', async ($, on) => {
  const { clock } = engine(on, { replies: ['["Login bug"]', '["Login bug", "Dark mode toggle"]'] })
  await type($, 'fix the login bug')
  await clock.settle()
  await type($, 'now add a dark mode toggle')
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    await ui.press({ key: 'topics-toggle' })
    expect((await ui.find({ key: 'topics-toggle' }))?.props.label).toBe('▸')
    expect(await ui.find({ type: 'Text', text: 'Dark mode toggle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Login bug/ })).toBeUndefined()
    await ui.press({ key: 'topics-toggle' })
    expect((await ui.find({ key: 'topics-toggle' }))?.props.label).toBe('▾')
    expect(await ui.find({ type: 'Text', text: ' · Login bug' })).toBeDefined()
    await ui.unmount()
  }
})

test('a narrow band cuts the topics to fit', async ($, on) => {
  const { clock } = engine(on, { replies: ['["Login bug", "A rather long topic name here"]'] })
  await type($, 'fix the login bug, then the long one')
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band(false, 20) })
    expect(await ui.find({ type: 'Text', text: 'A rather long t…' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Login bug/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a slash command counts by its arguments alone', async ($, on) => {
  const { asked, clock } = engine(on, { replies: ['["Topics band"]'] })
  await type($, '/goal build a band that shows the session topics')
  await type($, '/compact')
  await clock.settle()

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('build a band that shows the session topics')
  expect(asked[0]).not.toContain('/goal')
})

test("a plugin's prompt asks the model nothing", async ($, on) => {
  const { asked, clock } = engine(on)
  await $.prompt.submit({ text: 'a message from a plugin', wait: false, origin: { kind: 'plugin', name: 'other' } })
  await clock.settle()

  expect(asked).toEqual([])
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect(await ui.find({ type: 'Text', text: 'new session' })).toBeDefined()
  await ui.unmount()
})

test('a /clear starts the list over', async ($, on) => {
  const { clock } = engine(on, { replies: ['["Login bug"]'] })
  await type($, 'fix the login bug')
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band() })
    expect(await ui.find({ type: 'Text', text: 'new session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Login bug/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a resumed session gets its saved topics back with no model call', async ($, on) => {
  const { asked, clock } = engine(on, {
    store: { recent: { 'session-a': { topics: ['Saved topic'], at: 1 } } },
    messages: [userRow('an earlier prompt')],
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(asked).toEqual([])
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect(await ui.find({ type: 'Text', text: 'Saved topic' })).toBeDefined()
  await ui.unmount()
})

test('a resumed session with nothing saved asks about its earlier prompts', async ($, on) => {
  const { asked, clock } = engine(on, {
    replies: ['["Old work"]'],
    messages: [userRow('<command-name>/clear</command-name>'), userRow('refactor the old work module')],
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('refactor the old work module')
  expect(asked[0]).not.toContain('command-name')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect(await ui.find({ type: 'Text', text: 'Old work' })).toBeDefined()
  await ui.unmount()
})

test('the topics are saved for the session id and come back on a start', async ($, on) => {
  const { asked, clock } = engine(on, { replies: ['["Login bug"]'] })
  await type($, 'fix the login bug')
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(asked.length).toBe(1)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect(await ui.find({ type: 'Text', text: 'Login bug' })).toBeDefined()
  await ui.unmount()
})

test('a reply that is not a JSON list leaves the topics as they were', async ($, on) => {
  const { clock } = engine(on, { replies: ['["Login bug"]', 'Sorry, I cannot tell.'] })
  await type($, 'fix the login bug')
  await clock.settle()
  await type($, 'hmm')
  await clock.settle()

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  expect(await ui.find({ type: 'Text', text: 'Login bug' })).toBeDefined()
  await ui.unmount()
})

test('two sessions get different dot colors', async ($, on) => {
  const { session } = engine(on, { id: 'session-a' })
  const a = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  const colorA = (await a.find({ type: 'Text', text: ' ● ' }))?.props.color
  await a.unmount()

  session.id = 'session-b'
  const b = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...band() })
  const colorB = (await b.find({ type: 'Text', text: ' ● ' }))?.props.color
  await b.unmount()

  expect(typeof colorA).toBe('string')
  expect(colorB).not.toBe(colorA)
})

test('the row yields to a survey', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band(true) })
    expect(await ui.find({ type: 'Text', text: ' ● ' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})
