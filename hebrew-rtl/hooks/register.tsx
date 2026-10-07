import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { RTL, layout, plainVisual } from './bidi'
import type { Row, Span } from './bidi'

const isEnabled = atom({ plugin: 'hebrew-rtl', key: 'isEnabled' } as const, true)

const COMMAND = 'rtl'
const STORE_KEY = 'isEnabled'
// The reply's bullet column, and room left so that no row is wrapped again.
const GUTTER = 2
const SLACK = 4
const CODE_COLOR = 'permission'

const textProps = ({ style }: Span) => ({
  ...(style.bold && { bold: true }),
  ...(style.italic && { italic: true }),
  ...(style.underline && { underline: true }),
  ...(style.strike && { strikethrough: true }),
  ...(style.dim && { dimColor: true }),
  ...(style.code && { color: CODE_COLOR }),
})

async function toggle($: EngineInterface) {
  const value = await update($, isEnabled, v => !v)
  await $.store.set(STORE_KEY, value)
  $.ui.toast(value ? 'Hebrew RTL view is on' : 'Hebrew RTL view is off')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Turn the right-to-left Hebrew view on or off',
      immediate: true,
    })
    const stored = await $.store.get(STORE_KEY)
    await update($, isEnabled, () => stored !== false)

    return next(e)
  })

  // Answers with no text, so the toggle adds nothing to the transcript.
  on('command.run', { command: COMMAND }, async $ => {
    await toggle($)

    return {}
  }).catch(() => ({}))

  // Remote surfaces are HTML and do bidi themselves; only the terminal
  // paints Hebrew backwards.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !RTL.test(e.props.text) || !(await read($, isEnabled))) {
      return next(e)
    }

    const { Box, Markdown, Text } = $.ui.resolve(e)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - GUTTER - SLACK)
    const row = ({ align, spans }: Row) => (
      <Box flexDirection="row" justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
        {spans.length === 0 ? <Text> </Text> : spans.map(span => <Text {...textProps(span)}>{span.text}</Text>)}
      </Box>
    )

    return (
      <Box flexDirection="row" width="100%">
        <Box minWidth={GUTTER}>
          <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {layout(e.props.text, width).map(piece =>
            piece.kind === 'markdown' ? <Markdown text={piece.text} /> : piece.rows.map(row),
          )}
        </Box>
      </Box>
    )
  })

  // The prompt row keeps the engine's drawing; only its words are reordered.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !RTL.test(e.props.text) || !(await read($, isEnabled))) {
      return next(e)
    }

    const width = Math.max(20, (e.viewport?.columns ?? 80) - GUTTER - SLACK)

    return next({ ...e, props: { ...e.props, text: plainVisual(e.props.text, width) } })
  })
}
