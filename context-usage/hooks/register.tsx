import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Part, Usage } from '../types'

const usage = atom({ plugin: 'context-usage', key: 'usage' } as const, null)
const isExpanded = atom({ plugin: 'context-usage', key: 'isExpanded' } as const, false)

const COMMAND = 'context-bar'
const STORE_KEY = 'isExpanded'
const SMALL_BAR = 12
const LARGE_BAR = 20

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return `${n}`
}

function colorFor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 85) return 'error'
  if (percent >= 60) return 'warning'
  return 'success'
}

// With a breakdown, every figure comes from it, so the bar and the number
// agree with /context. Without one, the status line's figures stand alone.
function fromContext(context: SessionContextUsage): Usage {
  const b = context.breakdown
  if (b) {
    const parts = b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(({ name, color, tokens }) => ({ name, color, tokens }))
    return { tokens: b.totalTokens, window: b.rawMaxTokens, percent: b.percentage, parts }
  }
  const out: Usage = { window: context.window }
  if (context.tokens !== undefined) out.tokens = context.tokens
  if (context.percent !== undefined) out.percent = context.percent
  return out
}

// A local estimate by category; it sends no token-count requests.
async function measure($: EngineInterface): Promise<Usage | null> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    return fromContext(context)
  } catch {
    return null
  }
}

async function toggle($: EngineInterface) {
  const value = await update($, isExpanded, v => !v)
  await $.store.set(STORE_KEY, value)
}

// Split `filled` cells across the parts by token share, the sum kept exact.
function cellsFor(parts: Part[], filled: number): number[] {
  const total = parts.reduce((sum, p) => sum + p.tokens, 0)
  if (total === 0) return parts.map(() => 0)
  const exact = parts.map(p => (p.tokens / total) * filled)
  const cells = exact.map(Math.floor)
  let left = filled - cells.reduce((sum, n) => sum + n, 0)
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left -= 1
  }
  return cells
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Expand or minimize the context usage bar',
      immediate: true,
    })
    const stored = await $.store.get(STORE_KEY)
    await update($, isExpanded, () => stored === true)
    const current = await measure($)
    if (current) await update($, usage, () => current)

    return next(e)
  })

  // Pushed by the engine after each main-thread turn.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const current = (await measure($)) ?? fromContext(e.context)
      await update($, usage, () => current)
    }

    return next(e)
  })

  // The fill drops after a compaction; read it again once it is done.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // Never fail the compaction itself; the next measurement catches up.
    try {
      const current = await measure($)
      if (current) await update($, usage, () => current)
    } catch {}

    return result
  })

  // Answers with no text, so the toggle adds nothing to the transcript.
  on('command.run', { command: COMMAND }, async $ => {
    await toggle($)

    return {}
  }).catch(() => ({}))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // What other plugins drew in the band: drawn above this bar, never replaced.
    const below = await next(e)
    if (e.props.hasSurvey) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, usage)
    const expanded = await read($, isExpanded)

    const size = current?.window
    const percent = current?.percent
    const tokens = current?.tokens
    const parts = current?.parts ?? []

    const figure =
      percent === undefined
        ? ' --%'
        : expanded && tokens !== undefined && size
          ? ` ${percent}% · ${formatTokens(tokens)} / ${formatTokens(size)}`
          : ` ${percent}%`

    // The toggle's label and the space after it take six cells.
    const room = e.props.bodyColumns - 6 - figure.length
    const barWidth = Math.max(0, Math.min(expanded ? LARGE_BAR : SMALL_BAR, room))
    const fill = Math.min(100, Math.max(0, percent ?? 0))
    const filled = Math.round((fill / 100) * barWidth)
    const cells = cellsFor(parts, filled)
    const empty = Math.max(0, barWidth - filled)

    const bar = (
      <Box flexDirection="column">
        <Box>
          <Button
            key="toggle"
            plain
            dimColor
            label={expanded ? '▾ ctx' : '▸ ctx'}
            onPress={() => toggle($)}
          />
          <Text> </Text>
          {parts.length > 0
            ? parts.map(
                (part, i) =>
                  (cells[i] ?? 0) > 0 && (
                    <Text color={part.color}>{'█'.repeat(cells[i] ?? 0)}</Text>
                  ),
              )
            : filled > 0 && <Text color={colorFor(fill)}>{'█'.repeat(filled)}</Text>}
          {empty > 0 && <Text dimColor>{'░'.repeat(empty)}</Text>}
          <Text color={percent === undefined ? 'inactive' : colorFor(fill)} wrap="truncate">
            {figure}
          </Text>
        </Box>
        {expanded && parts.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {parts.map(part => (
              <Box>
                <Text color={part.color}>■ </Text>
                <Text dimColor>
                  {part.name} {formatTokens(part.tokens)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )

    return below.type === 'engine' ? bar : (
      <Box flexDirection="column">
        {below}
        {bar}
      </Box>
    )
  })
}
