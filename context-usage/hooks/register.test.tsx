import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const band = (hasSurvey: boolean) =>
  ({
    component: 'AbovePrompt',
    props: {
      hasSurvey,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  }) as const

const category = (name: string, color: string, tokens: number, kind: 'used' | 'free' | 'buffer') => ({
  name,
  color,
  tokens,
  kind,
  isDeferred: false,
})

const BREAKDOWN = {
  categories: [
    category('System tools', 'inactive', 12_000, 'used'),
    category('MCP tools', 'permission', 8_000, 'used'),
    category('Messages', 'promptBorder', 64_123, 'used'),
    category('Free space', 'subtle', 70_000, 'free'),
    category('Autocompact buffer', 'subtle', 45_000, 'buffer'),
  ],
  totalTokens: 84_123,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'model-default',
  percentage: 42,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
} satisfies SessionContextBreakdown

// Stand in for the engine beneath the plugin.
function engine(on: On, breakdown?: SessionContextBreakdown) {
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84_123, window: 200_000, percent: 42, ...(breakdown && { breakdown }) },
      rateLimits: [],
    },
  }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
}

const measure = ($: Engine) =>
  $.session.measure({
    context: { tokens: 84_123, window: 200_000, percent: 42 },
    rateLimits: [],
    changed: ['context'],
  })

test('minimized, the band shows the percent and no legend', async ($, on) => {
  engine(on, BREAKDOWN)
  await measure($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-usage', surface, ...band(false) })
    expect(await ui.find({ type: 'Text', text: ' 42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the toggle button expands the legend of used categories', async ($, on) => {
  engine(on, BREAKDOWN)
  await measure($)

  const ui = await $.ui.mount({ plugin: 'context-usage', surface: 'terminal', ...band(false) })
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: '42% · 84.1k / 200k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'MCP tools 8k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Messages 64.1k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Free space/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Autocompact/ })).toBeUndefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeUndefined()
  await ui.unmount()
})

test('the /context-bar command toggles the band', async ($, on) => {
  engine(on, BREAKDOWN)
  on('command.run', () => ({}))
  await measure($)

  const ui = await $.ui.mount({ plugin: 'context-usage', surface: 'desktop', ...band(false) })
  await $.command.run({
    command: 'context-bar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  })
  expect(await ui.find({ type: 'Text', text: 'Messages 64.1k' })).toBeDefined()
  await ui.unmount()
})

test('without a breakdown, the band falls back to one fill', async ($, on) => {
  engine(on)
  await measure($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-usage', surface, ...band(false) })
    expect(await ui.find({ type: 'Text', text: ' 42%' })).toBeDefined()
    await ui.unmount()
  }
})

test('a full window with a tiny category still draws', async ($, on) => {
  engine(on, {
    ...BREAKDOWN,
    categories: [
      category('Memory files', 'remember', 1, 'used'),
      category('Messages', 'promptBorder', 200_000, 'used'),
    ],
    totalTokens: 200_001,
    percentage: 100,
  })
  await measure($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-usage', surface, ...band(false) })
    expect(await ui.find({ type: 'Text', text: ' 100%' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: 'Memory files 1' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})

test('the bar keeps what other plugins drew in the band', async ($, on) => {
  engine(on, BREAKDOWN)
  await measure($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-usage', surface, ...band(false) })
    expect(await ui.find({ type: 'Text', text: ' 42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band yields to a survey', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-usage', surface, ...band(true) })
    expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})
