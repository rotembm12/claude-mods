// The agent inspector: the details pane of one agent, in five tabs. A hero says who the
// agent is and where it stands; the tab bar picks what to read: the outcome at a glance, the
// whole brief in cards, every step with its input and output, how the context grew, and the
// report. Desktop draws each section as a card and the charts as still SVG (the engine
// draws the pane again on every scroll step); the terminal draws their text twins.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { AgentDetails, AgentRequest, AgentRun, AgentStep, PaneTab } from '../types'
import {
  barCells,
  cleanDetails,
  clip,
  clockOf,
  codeRefs,
  duration,
  FILLS,
  GLYPHS,
  hardBreaks,
  itemsOf,
  labelOf,
  listify,
  marker,
  modelName,
  parseBrief,
  parseReport,
  phaseLabel,
  phasesOf,
  stateOf,
  SWATCHES,
  timeOf,
  tokenStats,
  toolsOf,
  typeOf,
} from './format'
import type { BriefSection, Phase } from './format'
import { budgetBar, budgetMeterSvg, formatTokens, kindOf, mixBarSvg, ORB_COLORS, PALETTE, sparkline, statusOrbSvg, timelineHeight, timelineSvg, tokenChartSvg } from './visuals'
import type { OrbState } from './visuals'

// An atom is declared in the module that reads it: these are the keys register.tsx writes.
const selected = atom({ plugin: 'orchestrator', key: 'selected' } as const, null)
const agents = atom({ plugin: 'orchestrator', key: 'agents' } as const, [])
const details = atom({ plugin: 'orchestrator', key: 'details' } as const, {})
// What only the pane keeps: its open tab, the step opened on the Steps tab, every step
// shown, and the report as written.
const tab = atom({ plugin: 'orchestrator', key: 'tab' } as const, 'overview')
const openStep = atom({ plugin: 'orchestrator', key: 'openStep' } as const, null)
const showAllSteps = atom({ plugin: 'orchestrator', key: 'showAllSteps' } as const, false)
const showRawReport = atom({ plugin: 'orchestrator', key: 'showRawReport' } as const, false)

// The context budget a subagent is sized to.
const BUDGET = 150_000
// The steps the Steps tab shows until it is asked for all of them.
const STEP_ROWS = 40
// The widest bar of the tool mix, in cells, and the detail lines under a phase.
const BAR_CELLS = 40
const PHASE_LINES = 3
// The phases the Overview shows.
const SHOWN_PHASES = 10
// A cell of the desktop pane in CSS pixels, about: what an SVG's width is sized from, so
// the drawing is near its slot's width and its text is drawn near its own size.
const CELL_PX = 9.6
// The engine draws the pane again on every scroll step. A chart whose source changes
// between two draws is a new frame on desktop: it reloads and flickers, and the pane's
// height jumps under the wheel. So the charts never animate in, and the clock they read
// moves in steps of this many milliseconds, not on every draw.
const CHART_TICK = 10_000
// What a section card's border and padding take, in cells.
const CARD_CELLS = 6
// Text on a colored chip: dark, which holds on every mid-tone of the palette.
const CHIP_TEXT = '#111827'

const ROLE_COLORS: Record<string, string> = { scout: PALETTE.explore, builder: PALETTE.edit, verifier: PALETTE.run }
const SECTION_COLORS: Record<BriefSection['id'], string> = {
  intro: PALETTE.muted,
  goal: PALETTE.other,
  context: PALETTE.explore,
  task: PALETTE.run,
  done: PALETTE.good,
  return: PALETTE.research,
  brief: PALETTE.muted,
}
const TAB_LABELS: [PaneTab, string][] = [
  ['overview', 'Overview'],
  ['brief', 'Brief'],
  ['steps', 'Steps'],
  ['tokens', 'Tokens'],
  ['report', 'Report'],
]

const kindColor = (tool: string): string => PALETTE[kindOf(tool)]
const levelColor = (frac: number): string => (frac >= 1 ? PALETTE.bad : frac >= 0.75 ? PALETTE.warn : PALETTE.good)
const isEdit = (tool: string) => kindOf(tool) === 'edit'
const percent = (frac: number) => `${Math.round(frac * 100)}%`
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : duration(ms))

// How an agent stands, as its state word and its run status say.
function toneOf(word: string, status: AgentRun['status']): string {
  return ORB_COLORS[word as OrbState] ?? (status === 'running' ? PALETTE.now : status === 'completed' ? PALETTE.good : status === 'failed' ? PALETTE.bad : PALETTE.muted)
}
const orbOf = (word: string, status: AgentRun['status']): OrbState =>
  word in ORB_COLORS ? (word as OrbState) : status === 'running' ? 'running' : status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'killed'

// `alert` colors the value on desktop too; otherwise only the terminal colors it.
type Stat = { value: string; what: string; color: string; alert?: boolean }

export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const ui = $.ui.resolve(e)
  const { Box, Button, Markdown, Text } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const id = await read($, selected)
  const runs: AgentRun[] = await read($, agents)
  const run = runs.find(r => r.id === id)
  if (run === undefined) return <Text dimColor>No agent to show. Open the band's details and click an agent.</Text>
  // Details an earlier version stored may hold control characters, which the drawing refuses.
  const stored: AgentDetails | undefined = (await read($, details))[run.id]
  const kept = stored === undefined ? undefined : cleanDetails(stored)
  const active: PaneTab = await read($, tab)
  const opened = await read($, openStep)
  const isAll = await read($, showAllSteps)
  const isRaw = await read($, showRawReport)

  const now = await $.clock.now()
  const chartNow = Math.floor(now / CHART_TICK) * CHART_TICK
  const isTerminal = e.surface === 'terminal'
  // A card's border and padding take four columns.
  const columns = Math.max(16, e.props.bodyColumns)
  const width = columns - 4
  const svgWidth = Math.min(960, Math.max(280, Math.round((columns - CARD_CELLS) * CELL_PX)))
  const [glyph] = GLYPHS[run.status]
  const word = stateOf(run)
  const tone = toneOf(word, run.status)
  const isRunning = run.status === 'running'
  const steps: AgentStep[] = kept?.steps ?? []
  const requests: AgentRequest[] = kept?.requests ?? []
  const report = kept?.report ?? null
  const parsed = report !== null ? parseReport(report) : null
  const latest = steps.at(-1)
  const stats = tokenStats(requests, steps, BUDGET)
  const hasTokens = requests.length > 0

  const edited = [...new Set(steps.filter(s => isEdit(s.tool) && s.path !== undefined).map(s => s.path as string))]
  const readFiles = [...new Set(steps.filter(s => s.tool === 'Read' && s.path !== undefined).map(s => s.path as string))]
  const failedCalls = steps.filter(s => s.isError).length

  // ---- Small pieces

  // A chart is drawn as an image, never `isInteractive`: that draws it in a frame of its
  // own, and a frame takes the wheel, so the pane would not scroll while the pointer is
  // over a chart. The cost is the charts' hover tooltips.
  const draw = (source: string, alt: string, size?: number) =>
    Svg === null ? null : <Svg source={source} alt={alt} {...(size !== undefined ? { width: size, height: size } : {})} />
  const chip = (label: string, color: string) => (
    <Text backgroundColor={color} color={CHIP_TEXT} bold size="caption">
      {` ${label.toUpperCase()} `}
    </Text>
  )
  const heading = (title: string, accent: string, aside?: string) => (
    <Box marginTop={1}>
      <Text color={accent} bold>
        {'▍'}
      </Text>
      <Text bold>{title.toUpperCase()}</Text>
      {aside !== undefined && <Text dimColor>{`  ${aside}`}</Text>}
    </Box>
  )
  // A section: on the terminal a heading over its rows; on desktop a card with one quiet
  // border, its title and an aside on top, so the pane reads as a stack of solid blocks.
  const section = (key: string, title: string, accent: string, aside: string | undefined, children: (JSX.Element | null | false)[], titleColor?: string) =>
    isTerminal ? (
      <Box key={key} flexDirection="column">
        {heading(title, accent, aside)}
        {children}
      </Box>
    ) : (
      <Box key={key} flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
        <Box justifyContent="space-between" alignItems="center" columnGap={2} flexWrap="wrap">
          <Text weight="semibold" size="heading" color={titleColor}>
            {title}
          </Text>
          {aside !== undefined && (
            <Box flexShrink={1}>
              <Text dimColor size="footnote">
                {aside}
              </Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
      </Box>
    )
  // Text that may run long, wrapped in the pane rather than held in a box of its own:
  // a Code block scrolls inside itself and, once it fills the view, keeps the wheel.
  const longText = (key: string, text: string, isError = false) => (
    <Box key={key} borderStyle="round" borderDimColor={!isError} borderColor={isError ? PALETTE.error : undefined} paddingX={1}>
      <Text mono wrap="wrap" size="footnote">
        {text}
      </Text>
    </Box>
  )
  const label = (title: string, color?: string) => (
    <Box marginTop={1}>
      <Text bold color={color}>
        {title}
      </Text>
    </Box>
  )
  const note = (text: string) => <Text dimColor>{text}</Text>
  const button = (key: string, text: string, onPress: () => Promise<unknown>) => (
    <Box marginTop={1}>
      <Button key={key} {...(isTerminal ? { plain: true as const } : { variant: 'secondary' as const })} label={text} onPress={onPress} />
    </Box>
  )

  // ---- The hero: who it is and where it stands

  let room = width
  const identity: [string, string | undefined, boolean][] = []
  for (const [text, color, isDim] of [
    [typeOf(run), ROLE_COLORS[typeOf(run)] ?? PALETTE.other, false],
    [' · ', undefined, true],
    [modelName(run.model, run.tier), undefined, false],
    [` · started ${duration(now - run.startedAt)} ago`, undefined, true],
  ] as [string, string | undefined, boolean][]) {
    const shown = clip(text, room)
    room -= shown.length
    if (shown !== '') identity.push([shown, color, isDim])
  }
  const meta = (
    <Box>
      {identity.map(([text, color, isDim], i) => (
        <Text key={`orchestrator-identity-${i}`} color={color} bold={color !== undefined} dimColor={isDim}>
          {text}
        </Text>
      ))}
    </Box>
  )

  const peakFrac = stats.peak / BUDGET
  const tiles: Stat[] = [
    ...(hasTokens ? [{ value: formatTokens(stats.totalOutput), what: 'tokens out', color: PALETTE.output }] : []),
    { value: timeOf(run, now), what: isRunning ? 'so far' : 'run time', color: PALETTE.now },
    { value: String(run.tools), what: run.tools === 1 ? 'tool call' : 'tool calls', color: PALETTE.explore },
    ...(edited.length > 0 ? [{ value: String(edited.length), what: edited.length === 1 ? 'file edited' : 'files edited', color: PALETTE.edit }] : []),
    ...(failedCalls > 0 ? [{ value: String(failedCalls), what: failedCalls === 1 ? 'failed call' : 'failed calls', color: PALETTE.error, alert: true }] : []),
  ]
  // A desktop tile: the caption on top, the number under it, both in the pane's own colors
  // unless the number is a warning. Tiles grow to share each row evenly.
  const tile = (key: string, caption: string, value: string, color?: string, extra?: JSX.Element | null) => (
    <Box key={key} flexDirection="column" flexGrow={1} minWidth={13} borderStyle="round" borderDimColor paddingX={1}>
      <Text size="caption" dimColor>
        {caption}
      </Text>
      <Text size="title" weight="semibold" tabular color={color}>
        {value}
      </Text>
      {extra}
    </Box>
  )
  const tileGrid = (rows: Stat[], lead?: JSX.Element) => (
    <Box marginTop={1} flexWrap="wrap" gap={1}>
      {lead}
      {rows.map(t => tile(`orchestrator-stat-${t.what}`, t.what, t.value, t.alert === true ? t.color : undefined))}
    </Box>
  )
  const meterWidth = Math.max(80, Math.min(220, Math.round((columns / 3) * CELL_PX)))
  const tokensTile = hasTokens
    ? tile(
        'orchestrator-tile-tokens',
        'peak context',
        formatTokens(stats.peak),
        peakFrac >= 0.75 ? levelColor(peakFrac) : undefined,
        <Box flexDirection="column" marginTop={1}>
          {draw(budgetMeterSvg(stats.peak, BUDGET, { width: meterWidth, animate: false }), `Peak context ${formatTokens(stats.peak)} of ${formatTokens(BUDGET)}, ${percent(peakFrac)}`)}
          <Text size="caption" dimColor tabular>{`${percent(peakFrac)} of ${formatTokens(BUDGET)} budget`}</Text>
        </Box>,
      )
    : tile('orchestrator-tile-tokens', 'context not recorded', '—')
  const statRow = isTerminal ? (
    <Box flexDirection="column" marginTop={1}>
      {hasTokens && (
        <Box>
          <Text bold color={levelColor(peakFrac)} tabular>
            {budgetBar(stats.peak, BUDGET, 12)}
          </Text>
          <Text dimColor>{`  ${formatTokens(stats.peak)} of ${formatTokens(BUDGET)} peak context`}</Text>
        </Box>
      )}
      <Box flexWrap="wrap">
        {tiles.map((t, i) => (
          <Box key={`orchestrator-stat-${t.what}`}>
            <Text bold tabular color={t.color}>
              {t.value}
            </Text>
            <Text dimColor>{` ${t.what}`}</Text>
            {i < tiles.length - 1 && <Text dimColor>{'  ·  '}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  ) : (
    tileGrid(tiles, tokensTile)
  )
  const hero = isTerminal ? (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Box gap={1} alignItems="center">
        <Text color={tone} bold>{`${glyph} `}</Text>
        <Box flexDirection="column" flexShrink={1}>
          <Box justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Text bold>{labelOf(run)}</Text>
            </Box>
            {chip(word, tone)}
          </Box>
          {run.name !== null && <Text>{run.description}</Text>}
          {meta}
        </Box>
      </Box>
      {statRow}
    </Box>
  ) : (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
      <Box gap={2} alignItems="center">
        {draw(statusOrbSvg(orbOf(word, run.status), { size: 36, animate: true }), `Agent ${word}`, 36)}
        <Box flexDirection="column" flexShrink={1} flexGrow={1}>
          <Text weight="semibold" size="title">
            {labelOf(run)}
          </Text>
          {run.name !== null && <Text dimColor>{run.description}</Text>}
          <Box marginTop={1} columnGap={1} alignItems="center" flexWrap="wrap">
            {chip(word, tone)}
            {meta}
          </Box>
        </Box>
      </Box>
      {statRow}
    </Box>
  )

  // ---- The tab bar

  const countOf = (t: PaneTab): string =>
    t === 'steps' ? (latest !== undefined ? ` ${latest.n}` : '') : t === 'tokens' ? (hasTokens ? ` ${formatTokens(stats.peak)}` : '') : t === 'report' ? (report !== null ? ' ✓' : '') : ''
  const tabBar = (
    <Box marginTop={1} flexWrap="wrap" gap={isTerminal ? 1 : undefined}>
      {TAB_LABELS.map(([t, name], i) => {
        // Desktop keeps the labels short so the five fit one row; the numbers are in the tiles.
        const text = isTerminal ? `${name}${countOf(t)}` : name
        const press = () => update($, tab, () => t)
        const key = `orchestrator-tab-${t}`
        return isTerminal ? (
          <Button key={key} plain hotkey={String(i + 1)} label={` ${text} `} onPress={press}>
            {t === active ? (
              <Text inverse bold>
                {` ${text} `}
              </Text>
            ) : (
              <Text>{` ${text} `}</Text>
            )}
          </Button>
        ) : (
          <Button key={key} hotkey={String(i + 1)} variant={t === active ? 'primary' : 'secondary'} label={text} onPress={press} />
        )
      })}
    </Box>
  )

  // ---- The outcome: the report by the contract's fields

  const answerBox = (caption: string, body: JSX.Element | (JSX.Element | false)[]) =>
    isTerminal ? (
      <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
        <Text dimColor>{caption}</Text>
        {body}
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text dimColor size="caption" weight="medium">
          {caption}
        </Text>
        {body}
      </Box>
    )
  const working = (
    <Box flexDirection="column">
      <Text color={PALETTE.now}>● Working</Text>
      {latest !== undefined && (
        <Box>
          <Text dimColor>{'now: '}</Text>
          <Text color={kindColor(latest.tool)}>{latest.tool}</Text>
          <Text>{` ${clip(latest.target, width - latest.tool.length - 6)}`}</Text>
        </Box>
      )}
    </Box>
  )
  const noReport = report === null ? (isRunning ? working : note(run.status === 'killed' ? 'Stopped before it reported.' : 'No report.')) : null
  const verdict = /^(PASS|FAIL|CONCERNS)\b[\s:.,-]*/.exec(parsed?.answer ?? '')
  const verdictTone = verdict?.[1] === 'PASS' ? PALETTE.good : verdict?.[1] === 'FAIL' ? PALETTE.bad : PALETTE.warn
  const answer = verdict !== null ? (parsed?.answer ?? '').slice(verdict[0].length) : parsed?.answer
  const hasAnswer = answer !== undefined && answer !== ''
  const answerView =
    parsed !== null && (verdict?.[1] !== undefined || hasAnswer)
      ? answerBox('Answer', [
          verdict?.[1] !== undefined && (
            <Box key="orchestrator-verdict" marginBottom={hasAnswer ? 1 : 0}>
              {chip(verdict[1], verdictTone)}
            </Box>
          ),
          hasAnswer && <Markdown key="orchestrator-answer" text={hardBreaks(codeRefs(answer))} />,
        ])
      : null
  const openItems = parsed?.open !== undefined ? itemsOf(parsed.open).length : 0
  const changeItems = parsed?.changes !== undefined ? itemsOf(parsed.changes) : []
  const reported = parsed?.status !== undefined && parsed.status !== word ? `reported ${parsed.status}` : undefined

  const glance = (): JSX.Element => {
    if (report === null) return noReport as JSX.Element
    if (parsed === null) return answerBox('Report', <Markdown key="orchestrator-report" text={hardBreaks(report)} />)
    return (
      <Box flexDirection="column">
        {answerView}
        {changeItems.length > 0 && label('✎ Top changes', PALETTE.edit)}
        {changeItems.length > 0 && <Markdown key="orchestrator-changes" text={hardBreaks(listify(changeItems.slice(0, 3).join('\n')))} />}
        {changeItems.length > 3 && note(`+${changeItems.length - 3} more in the Report tab`)}
        {openItems > 0 && (
          <Box marginTop={1}>
            <Text color={PALETTE.warn} bold>{`⚑ ${openItems} open ${openItems === 1 ? 'question or risk' : 'questions & risks'}`}</Text>
          </Box>
        )}
      </Box>
    )
  }

  // ---- What it did: phases, the tool mix, files

  const counts: Record<string, number> = {}
  for (const step of steps) counts[step.tool] = (counts[step.tool] ?? 0) + 1
  const mix = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const phases = phasesOf(steps)
  const earlier = Math.max(0, phases.length - SHOWN_PHASES)
  const isWorking = isRunning && latest !== undefined && latest.ms === null
  const lineCells = width - 4
  const phaseView = (phase: Phase, index: number) => {
    const first = phase.steps[0] as AgentStep
    const last = phase.steps.at(-1) as AgentStep
    const tally: Record<string, number> = {}
    for (const step of phase.steps) tally[step.tool] = (tally[step.tool] ?? 0) + 1
    const failed = phase.steps.filter(s => s.isError).length
    // Up to three detail lines, then how many more there were.
    const lines: { text: string; mark?: string; markColor?: string }[] =
      phase.kind === 'edit'
        ? [...new Set(phase.steps.map(s => s.path ?? s.target).filter(t => t !== ''))].map(path => ({ text: `✎ ${path}` }))
        : phase.kind === 'run'
          ? phase.steps.filter(s => s.target !== '').map(s => ({ text: s.target, mark: s.ms === null ? '●' : s.isError ? '✗' : '✓', markColor: s.ms === null ? PALETTE.run : s.isError ? PALETTE.error : undefined }))
          : [...new Set(phase.steps.map(s => s.target).filter(t => t !== ''))].map(text => ({ text }))
    const shown = lines.slice(0, PHASE_LINES)
    const more = lines.length - shown.length
    const span = `${clockOf(first.at)}–${clockOf(last.ms !== null ? last.at + last.ms : last.at)}`
    const color = kindColor(first.tool)
    return (
      <Box key={`orchestrator-phase-${index}`} flexDirection="column" marginTop={1}>
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold color={color}>{marker(index + 1)}</Text>
          <Text bold color={color}>{clip(phaseLabel(phase), width - 4)}</Text>
          <Text dimColor>·</Text>
          <Text dimColor tabular>{span}</Text>
          <Text dimColor>·</Text>
          <Text>{Object.entries(tally).map(([tool, n]) => `${tool} ×${n}`).join(' · ')}</Text>
          {failed > 0 && <Text color={PALETTE.error}>{`${failed} failed`}</Text>}
          {isWorking && index === phases.length - 1 && <Text color={PALETTE.run}>● in progress</Text>}
        </Box>
        {shown.map((line, i) => (
          <Box key={`orchestrator-phase-${index}-line-${i}`} paddingLeft={3}>
            {line.mark !== undefined && <Text color={line.markColor} dimColor={line.markColor === undefined}>{`${line.mark} `}</Text>}
            <Text dimColor={line.markColor !== PALETTE.error} color={line.markColor === PALETTE.error ? PALETTE.error : undefined}>
              {clip(line.text, lineCells - (line.mark !== undefined ? 2 : 0))}
            </Text>
          </Box>
        ))}
        {more > 0 && (
          <Box paddingLeft={3}>
            <Text dimColor>{`+${more} more`}</Text>
          </Box>
        )}
      </Box>
    )
  }

  // One bar for the tool mix: cells in proportion to each tool's calls. Where there
  // are more tools than cells, the smallest share one "other" segment.
  const barWidth = Math.min(BAR_CELLS, width)
  const segments: [string, number][] =
    mix.length > barWidth ? [...mix.slice(0, barWidth - 1), ['other', mix.slice(barWidth - 1).reduce((sum, [, n]) => sum + n, 0)]] : mix
  const sizes = barCells(segments.map(([, n]) => n), barWidth)
  const seenColors: Record<string, number> = {}
  const fills = segments.map(([tool]) => {
    const color = kindColor(tool)
    const turn = seenColors[color] ?? 0
    seenColors[color] = turn + 1
    return turn % FILLS.length
  })
  const toolMix = !isTerminal ? (
    <Box flexDirection="column">
      {draw(mixBarSvg(segments.map(([tool, n], i) => ({ name: tool, count: n, color: kindColor(tool), shade: fills[i] })), { width: svgWidth }), `Tool mix: ${segments.map(([tool, n]) => `${tool} ${n}`).join(', ')}`)}
      <Box marginTop={1} flexWrap="wrap" columnGap={2}>
        {segments.map(([tool, n], i) => (
          <Text key={`orchestrator-legend-${tool}`} mono size="footnote" color={kindColor(tool)}>{clip(`${SWATCHES[fills[i] as number]} ${tool} ${n}`, width)}</Text>
        ))}
      </Box>
    </Box>
  ) : (
    <Box flexDirection="column">
      <Box>
        {segments.map(([tool], i) => (
          <Text key={`orchestrator-bar-${tool}`} mono color={kindColor(tool)}>
            {(FILLS[fills[i] as number] as string).repeat(sizes[i] as number)}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexWrap="wrap" columnGap={2}>
        {segments.map(([tool, n], i) => (
          <Text key={`orchestrator-legend-${tool}`} mono color={kindColor(tool)}>{clip(`${SWATCHES[fills[i] as number]} ${tool} ${n}`, width)}</Text>
        ))}
      </Box>
    </Box>
  )
  const noSteps = note(
    kept?.steps === undefined && run.tools > 0
      ? 'Steps not kept: this agent started before the mod kept them.'
      : isRunning
        ? 'No tool calls yet.'
        : 'No tool calls: it answered from its brief.',
  )

  const timeline = (): JSX.Element | null =>
    steps.length === 0
      ? null
      : draw(
          timelineSvg(steps, { width: svgWidth, height: timelineHeight(steps), totalMs: isRunning ? chartNow - run.startedAt : undefined, isRunning, animate: false }),
          `Timeline of ${steps.length} tool calls over ${duration(Math.max(run.runMs, (latest?.at ?? 0) + (latest?.ms ?? 0)))}, one lane per kind of tool`,
        )
  const contextBars = (compact: boolean): JSX.Element | null => {
    if (!hasTokens) return null
    if (!isTerminal)
      return draw(
        tokenChartSvg(requests, steps, { width: svgWidth, height: compact ? 210 : 300, budget: BUDGET, isRunning, animate: false }),
        `Context per request: ${requests.length} requests, peak ${formatTokens(stats.peak)} of ${formatTokens(BUDGET)}, now ${formatTokens(stats.current)}`,
      )
    return (
      <Box flexDirection="column">
        <Text color={levelColor(peakFrac)} mono>
          {sparkline(requests.map(r => r.prompt), Math.min(width, 60, Math.max(requests.length, 12)))}
        </Text>
        <Text dimColor>{`${budgetBar(stats.peak, BUDGET, 20)} peak ${formatTokens(stats.peak)} of ${formatTokens(BUDGET)}`}</Text>
      </Box>
    )
  }

  const overview = (): JSX.Element => (
    <Box flexDirection="column">
      {section('orchestrator-section-outcome', 'Outcome', tone, reported, [glance()])}
      {hasTokens && section('orchestrator-section-context', 'Context', PALETTE.output, `${requests.length} ${requests.length === 1 ? 'request' : 'requests'}`, [contextBars(true)])}
      {steps.length > 0 && !isTerminal && section('orchestrator-section-timeline', 'Timeline', PALETTE.now, toolsOf(run), [timeline()])}
      {section('orchestrator-section-did', 'What it did', PALETTE.explore, `${toolsOf(run)}${failedCalls > 0 ? ` · ${failedCalls} failed` : ''}${isRunning && run.lastTool !== null ? ` · last ${run.lastTool}` : ''}`, [
        steps.length === 0 ? (
          noSteps
        ) : (
          <Box key="orchestrator-did" flexDirection="column">
            {earlier > 0 && (
              <Box marginTop={1}>
                <Text dimColor>{`⋯ ${earlier} earlier ${earlier === 1 ? 'phase' : 'phases'}`}</Text>
              </Box>
            )}
            {phases.slice(earlier).map((phase, i) => phaseView(phase, earlier + i))}
            {label('Tool mix')}
            {toolMix}
            {edited.length > 0 && label('Files edited', PALETTE.edit)}
            {edited.map(path => (
              <Text key={`orchestrator-edited-${path}`} mono>{`✎ ${clip(path, width - 2)}`}</Text>
            ))}
            {readFiles.length > 0 && label('Files read', PALETTE.explore)}
            {readFiles.length > 0 && (
              <Text dimColor>{clip(readFiles.slice(0, 6).join(', ') + (readFiles.length > 6 ? ` +${readFiles.length - 6} more` : ''), width * 2)}</Text>
            )}
          </Box>
        ),
      ])}
    </Box>
  )

  // ---- Brief: the whole of it, in a card per section

  const briefTab = (): JSX.Element => {
    if (kept === undefined) return note('Not kept: this agent started before the mod kept briefs.')
    const sections = parseBrief(kept.brief)
    const chars = kept.brief.length
    return (
      <Box flexDirection="column">
        {isTerminal && heading('Brief', PALETTE.other, sections.length > 1 ? `${sections.length} sections` : undefined)}
        <Box flexDirection="column" gap={isTerminal ? 1 : undefined} marginTop={isTerminal ? 1 : undefined}>
          {sections.map((s, i) =>
            isTerminal ? (
              <Box key={`orchestrator-brief-${i}`} flexDirection="column" borderStyle="round" borderColor={SECTION_COLORS[s.id]} paddingX={1}>
                <Text bold color={SECTION_COLORS[s.id]}>{`${s.icon} ${s.title}`}</Text>
                {s.body !== '' ? <Markdown key={`orchestrator-brief-text-${i}`} text={hardBreaks(s.body)} /> : note('(empty)')}
              </Box>
            ) : (
              section(`orchestrator-brief-${i}`, `${s.icon} ${s.title}`, SECTION_COLORS[s.id], undefined, [
                s.body !== '' ? <Markdown key={`orchestrator-brief-text-${i}`} text={hardBreaks(s.body)} /> : note('(empty)'),
              ])
            ),
          )}
          {sections.length === 0 && note('The brief is empty.')}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{`${chars.toLocaleString('en-US')} characters · ≈${formatTokens(Math.round(chars / 4))} tokens`}</Text>
        </Box>
      </Box>
    )
  }

  // ---- Steps: every call, each one opened to its input and output

  const stepsTab = (): JSX.Element => {
    if (steps.length === 0) return section('orchestrator-section-steps', 'Steps', PALETTE.explore, undefined, [noSteps])
    const folded = !isAll && steps.length > STEP_ROWS
    const shown = folded ? steps.slice(-STEP_ROWS) : steps
    const dropped = (latest?.n ?? 0) - steps.length
    const nameCells = Math.min(12, Math.max(4, ...steps.map(s => s.tool.length)))
    const targetCells = Math.max(8, width - 2 - 2 - 5 - 1 - nameCells - 1 - 8)
    const detail = (step: AgentStep) => {
      const color = kindColor(step.tool)
      return (
        <Box key={`orchestrator-step-detail-${step.n}`} flexDirection="column" borderStyle="round" borderColor={isTerminal ? color : undefined} borderDimColor={!isTerminal} paddingX={1} marginBottom={1}>
          <Box flexWrap="wrap" columnGap={1}>
            <Text bold color={color}>{`#${step.n} ${step.tool}`}</Text>
            {step.ms !== null ? <Text dimColor>{`took ${took(step.ms)}`}</Text> : <Text color={PALETTE.run}>● running</Text>}
            <Text dimColor>{`at ${clockOf(step.at)}`}</Text>
            {step.isError && chip('failed', PALETTE.error)}
          </Box>
          {label('Input', PALETTE.explore)}
          {step.input !== undefined && step.input !== '' ? longText(`orchestrator-step-input-${step.n}`, step.input) : note('Input not kept')}
          {label('Output', step.isError ? PALETTE.error : PALETTE.output)}
          {step.output !== undefined && step.output !== '' ? (
            longText(`orchestrator-step-output-${step.n}`, step.output, step.isError)
          ) : (
            note(step.ms === null ? 'Still running…' : 'Output not kept')
          )}
        </Box>
      )
    }
    const row = (step: AgentStep) => {
      const [mark, markColor] = step.ms === null ? ['●', PALETTE.run] : step.isError ? ['✗', PALETTE.error] : ['✓', PALETTE.good]
      const chevron = opened === step.n ? '▾' : '▸'
      const target = clip(step.target, targetCells)
      const tool = clip(step.tool, nameCells).padEnd(nameCells)
      const time = clockOf(step.at).padStart(5)
      return (
        <Box key={`orchestrator-step-row-${step.n}`} flexDirection="column">
          <Button
            key={`orchestrator-step-${step.n}`}
            plain
            label={`${chevron} ${mark} ${time} ${tool} ${target}`}
            onPress={() => update($, openStep, (open: number | null) => (open === step.n ? null : step.n))}
          >
            <Text dimColor>{`${chevron} `}</Text>
            <Text color={markColor} bold>{`${mark} `}</Text>
            <Text dimColor mono tabular>{time}</Text>
            <Text mono bold color={kindColor(step.tool)}>{` ${tool} `}</Text>
            <Text color={step.isError ? PALETTE.error : undefined}>{target}</Text>
            {step.ms !== null && step.ms >= 1000 && <Text dimColor tabular>{` ${duration(step.ms)}`}</Text>}
          </Button>
          {opened === step.n && detail(step)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {!isTerminal && section('orchestrator-section-timeline', 'Timeline', PALETTE.now, toolsOf(run), [timeline()])}
        {section('orchestrator-section-steps', 'Steps', PALETTE.explore, `${toolsOf(run)}${failedCalls > 0 ? ` · ${failedCalls} failed` : ''} · press a call to open its input and output`, [
          folded && (
            <Box key="orchestrator-steps-folded" marginTop={1}>
              <Text dimColor>{`⋯ ${steps.length - STEP_ROWS} earlier calls`}</Text>
            </Box>
          ),
          isAll && dropped > 0 && <Text key="orchestrator-steps-dropped" dimColor>{`The first ${dropped} calls were not kept.`}</Text>,
          <Box key="orchestrator-steps-rows" flexDirection="column" marginTop={isTerminal ? 1 : undefined}>
            {shown.map(row)}
          </Box>,
          steps.length > STEP_ROWS &&
            button('orchestrator-steps-toggle', isAll ? `▴ Show the latest ${STEP_ROWS}` : `▾ Show all ${steps.length} calls`, () => update($, showAllSteps, (open: boolean) => !open)),
        ])}
      </Box>
    )
  }

  // ---- Tokens: how the context grew

  const tokensTab = (): JSX.Element => {
    if (!hasTokens)
      return section('orchestrator-section-tokens', 'Tokens', PALETTE.output, undefined, [
        note(kept?.requests === undefined ? 'No requests recorded: this agent started before the mod kept token usage.' : 'No requests recorded yet.'),
      ])
    const currentFrac = stats.current / BUDGET
    const rows: Stat[] = [
      { value: formatTokens(stats.peak), what: `peak context · ${percent(peakFrac)} of ${formatTokens(BUDGET)}`, color: levelColor(peakFrac), alert: peakFrac >= 0.75 },
      { value: formatTokens(stats.current), what: `now · ${percent(currentFrac)} of ${formatTokens(BUDGET)}`, color: levelColor(currentFrac), alert: currentFrac >= 0.75 },
      { value: String(stats.count), what: stats.count === 1 ? 'request' : 'requests', color: PALETTE.explore },
      { value: formatTokens(stats.totalOutput), what: 'output tokens', color: PALETTE.output },
      { value: formatTokens(stats.totalPrompt), what: 'prompt tokens processed', color: PALETTE.research },
      { value: percent(stats.cacheRate), what: 'cache hit rate', color: PALETTE.good },
      { value: `${stats.growth >= 0 ? '+' : '-'}${formatTokens(Math.abs(stats.growth))}`, what: 'average growth per request', color: PALETTE.other },
    ]
    const callsOf = (calls: AgentStep[]) =>
      calls.length === 0
        ? 'no tool calls between'
        : `after ${calls.slice(0, 2).map(c => `${c.tool}${c.target !== '' ? ` ${c.target}` : ''}`).join(', ')}${calls.length > 2 ? ` +${calls.length - 2} more` : ''}`
    return (
      <Box flexDirection="column">
        {section('orchestrator-section-tokens', 'Tokens', PALETTE.output, `${stats.count} ${stats.count === 1 ? 'request' : 'requests'}`, [
          <Box key="orchestrator-tokens-chart" flexDirection="column" marginTop={isTerminal ? 1 : undefined}>
            {contextBars(false)}
          </Box>,
          isTerminal ? (
            <Box key="orchestrator-tokens-numbers" flexDirection="column" marginTop={1}>
              {rows.map(r => (
                <Box key={`orchestrator-number-${r.what}`}>
                  <Text bold tabular color={r.color}>
                    {r.value.padStart(7)}
                  </Text>
                  <Text dimColor>{`  ${r.what}`}</Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Box key="orchestrator-tokens-numbers" flexDirection="column">
              {tileGrid(rows)}
            </Box>
          ),
        ])}
        {stats.jumps.length > 0 &&
          section('orchestrator-section-jumps', 'Biggest jumps', PALETTE.warn, 'where the context grew most', [
            ...stats.jumps.map(j => (
              <Box key={`orchestrator-jump-${j.request}`} columnGap={1} flexWrap="wrap">
                <Text bold color={levelColor(j.prompt / BUDGET)} tabular>{`+${formatTokens(j.delta)}`}</Text>
                <Text dimColor>{`request #${j.request} → ${formatTokens(j.prompt)}`}</Text>
                <Text color={j.calls[0] !== undefined ? kindColor(j.calls[0].tool) : undefined}>{clip(callsOf(j.calls), Math.max(20, width - 32))}</Text>
              </Box>
            )),
            stats.over.length > 0 && (
              <Box key="orchestrator-over" marginTop={1}>
                <Text color={PALETTE.bad} bold>
                  {`Over the ${formatTokens(BUDGET)} budget: ${stats.over.length === 1 ? 'request' : 'requests'} ${stats.over.slice(0, 6).map(n => `#${n}`).join(', ')}${stats.over.length > 6 ? ` +${stats.over.length - 6} more` : ''}`}
                </Text>
              </Box>
            ),
          ])}
      </Box>
    )
  }

  // ---- Report: the fields, then the report as written

  const reportTab = (): JSX.Element => {
    if (report === null) return section('orchestrator-section-report', 'Report', tone, undefined, [noReport])
    const evidence =
      parsed?.evidence !== undefined ? (
        <Box key="orchestrator-evidence-block" flexDirection="column">
          {label('⌕ Evidence', PALETTE.explore)}
          <Markdown key="orchestrator-evidence" text={hardBreaks(listify(parsed.evidence))} />
        </Box>
      ) : null
    const open =
      parsed?.open !== undefined ? (
        <Box key="orchestrator-open-block" flexDirection="column">
          {label('⚑ Open questions & risks', PALETTE.warn)}
          <Markdown key="orchestrator-open" text={hardBreaks(listify(parsed.open))} />
        </Box>
      ) : null
    const openFirst = parsed?.status === 'partial' || parsed?.status === 'blocked'
    return section('orchestrator-section-report', 'Report', tone, reported, [
      parsed === null ? (
        answerBox('Report', <Markdown key="orchestrator-report" text={hardBreaks(report)} />)
      ) : (
        <Box key="orchestrator-report-fields" flexDirection="column">
          {answerView}
          {parsed.changes !== undefined && label('✎ Changes', PALETTE.edit)}
          {parsed.changes !== undefined && <Markdown key="orchestrator-changes-all" text={hardBreaks(listify(parsed.changes))} />}
          {openFirst ? open : evidence}
          {openFirst ? evidence : open}
          {parsed.notes !== '' && label('Notes')}
          {parsed.notes !== '' && <Markdown key="orchestrator-notes" dimColor text={hardBreaks(parsed.notes)} />}
        </Box>
      ),
      parsed !== null &&
        button('orchestrator-report-raw', isRaw ? '▴ Hide the raw report' : `▾ Show the raw report (${report.length.toLocaleString('en-US')} characters)`, () => update($, showRawReport, (open: boolean) => !open)),
      // Wrapped in the pane, not a Code block: one that scrolls inside itself kept the wheel
      // once it filled the view, and the pane could not be scrolled back up.
      parsed !== null && isRaw && (
        <Box key="orchestrator-report-raw-text" marginTop={1}>
          {longText('orchestrator-report-raw-body', report)}
        </Box>
      ),
    ])
  }

  const body = active === 'brief' ? briefTab() : active === 'steps' ? stepsTab() : active === 'tokens' ? tokensTab() : active === 'report' ? reportTab() : overview()
  return (
    <Box flexDirection="column">
      {hero}
      {tabBar}
      {body}
    </Box>
  )
}
