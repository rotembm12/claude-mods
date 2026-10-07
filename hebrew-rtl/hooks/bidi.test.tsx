import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isRtl, layout, plainVisual, visualText, wrap } from './bidi'

const plain = (text: string) => [{ text, style: {} }]
const joined = (spans: { text: string }[]) => spans.map(s => s.text).join('')

test('a Hebrew word is painted in reverse', async () => {
  expect(visualText('שלום', true)).toBe('םולש')
})

test('Latin words and numbers keep their own order inside a Hebrew line', async () => {
  expect(visualText('שלום abc 123.', true)).toBe('.abc 123 םולש')
  expect(visualText('עלייה של 50% השנה', true)).toBe('הנשה 50% לש היילע')
})

test('a Hebrew word inside an English line flips in place', async () => {
  expect(visualText('use שלום here', false)).toBe('use םולש here')
})

test('brackets are mirrored inside right-to-left text', async () => {
  expect(visualText('שלום (עולם)', true)).toBe('(םלוע) םולש')
})

test('niqqud stays on its letter', async () => {
  const shalom = 'שָׁלוֹם'
  expect(visualText(shalom, true)).toBe('םוֹלשָׁ')
})

test('flags, paths and prefixed English words read correctly', async () => {
  expect(visualText('הרץ --help עכשיו', true)).toBe('וישכע --help ץרה')
  expect(visualText('פתח את src/App.tsx כאן', true)).toBe('ןאכ src/App.tsx תא חתפ')
  expect(visualText('השתמשו ב-React כאן', true)).toBe('ןאכ React-ב ושמתשה')
})

test('punctuation after an English word lands on the reading side', async () => {
  expect(visualText('אני אוהב React, וגם Vue.', true)).toBe('.Vue םגו ,React בהוא ינא')
})

test('a line reads right to left when Hebrew leads or dominates', async () => {
  expect(isRtl(plain('שלום world'))).toBe(true)
  expect(isRtl(plain('React הוא ספרייה'))).toBe(true)
  expect(isRtl(plain('Use the שלום word here'))).toBe(false)
  expect(isRtl([{ text: 'npm run build', style: { code: true } }, { text: ' מריץ', style: {} }])).toBe(true)
})

test('wrapping happens in reading order, before the reorder', async () => {
  const lines = wrap(plain('אחת שתיים שלוש ארבע'), 10).map(joined)
  expect(lines).toEqual(['אחת שתיים', 'שלוש ארבע'])
})

test('a reply becomes right-aligned rows, with code left to the engine', async () => {
  const pieces = layout('שלום **עולם**\n\n```js\n// הערה\nconst a = 1\n```', 40)
  expect(pieces).toEqual([
    {
      kind: 'rows',
      rows: [
        { align: 'right', spans: [{ text: 'םלוע', style: { bold: true } }, { text: ' םולש', style: {} }] },
        { align: 'left', spans: [] },
      ],
    },
    { kind: 'markdown', text: '```js\n// הרעה\nconst a = 1\n```' },
  ])
})

test('list markers move to the right of Hebrew items', async () => {
  const rows = layout('- פריט ראשון\n1. צעד', 40).flatMap(p => (p.kind === 'rows' ? p.rows : []))
  expect(rows.map(r => joined(r.spans))).toEqual(['ןושאר טירפ •', 'דעצ .1'])
  expect(rows.every(r => r.align === 'right')).toBe(true)
})

test('a Hebrew table has its columns reversed and right-aligned', async () => {
  const pieces = layout('| שם | גיל |\n|---|---|\n| דנה | 30 |', 40)
  expect(pieces).toEqual([{ kind: 'markdown', text: '| ליג | םש |\n| ---: | ---: |\n| 30 | הנד |' }])
})

test('an English reply is left alone', async () => {
  expect(layout('Hello **world**', 40)).toEqual([{ kind: 'markdown', text: 'Hello **world**' }])
})

test('a prompt is wrapped and reordered as plain text', async () => {
  expect(plainVisual('שלום עולם\nhello', 80)).toBe('םלוע םולש\nhello')
})

// Stand in for the engine's own drawing beneath the plugin.
function engine(on: On) {
  mock.store(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const reply = (text: string) =>
  ({
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 80, rows: 24 },
  }) as const

test('the terminal draws a Hebrew reply right to left', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'hebrew-rtl', surface: 'terminal', ...reply('שלום עולם') })
  expect(await ui.find({ type: 'Text', text: 'םלוע םולש' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeUndefined()
})

test('an English reply and every remote surface keep the engine drawing', async ($, on) => {
  engine(on)
  const english = await $.ui.mount({ plugin: 'hebrew-rtl', surface: 'terminal', ...reply('Hello world') })
  expect(await english.find({ type: 'Text', text: 'engine' })).toBeDefined()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'hebrew-rtl', surface, ...reply('שלום עולם') })
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  }
})

const RTL_COMMAND = {
  command: 'rtl',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

test('/rtl turns the view off and on again', async ($, on) => {
  engine(on)
  await $.command.run(RTL_COMMAND)
  const off = await $.ui.mount({ plugin: 'hebrew-rtl', surface: 'terminal', ...reply('שלום עולם') })
  expect(await off.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await $.command.run(RTL_COMMAND)
  const on2 = await $.ui.mount({ plugin: 'hebrew-rtl', surface: 'terminal', ...reply('שלום עולם') })
  expect(await on2.find({ type: 'Text', text: 'םלוע םולש' })).toBeDefined()
})
