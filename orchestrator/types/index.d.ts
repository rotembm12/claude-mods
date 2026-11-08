export type Saved = { isOn: boolean; at: number }

// One subagent the main loop started while the mode was on.
export type AgentRun = {
  id: string
  name: string | null
  type: string
  tier: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  // The STATUS word of its last report (done, partial, blocked, failed), when it gave one.
  outcome: string | null
  startedAt: number
  // When its current run started: a follow-up message starts another.
  since: number
  // The time of its finished runs.
  runMs: number
  tools: number
  lastTool: string | null
  // The model id it runs on. Optional: runs an earlier version kept have none.
  model?: string
}

// One tool call a subagent made, as the details pane's step list shows it.
export type AgentStep = {
  // Its place among the agent's calls, from 1: what a finished call is found by.
  n: number
  tool: string
  // What it acted on, short: a path, a pattern, a command, a URL, a query.
  target: string
  // The file it read or edited, relative to the session's folder, for file tools.
  path?: string
  // When it started, in ms after the agent started.
  at: number
  // How long it took, or null while it runs.
  ms: number | null
  isError: boolean
  // The call's arguments as JSON, clipped to KEEP_IO_CHARS. Absent on steps an
  // earlier version kept, and dropped from the details of all but the newest agents.
  input?: string
  // The start of what the tool answered (its text, or the deny), clipped the same way.
  // Absent while the call runs.
  output?: string
}

// One model request of a subagent, from the `turn.step` result's usage.
export type AgentRequest = {
  // When it was answered, in ms after the agent started.
  at: number
  // The prompt it sent: input + cache read + cache creation tokens, the agent's
  // context size at that request, measured against the 150K budget.
  prompt: number
  // Of `prompt`, the tokens the prompt cache served.
  cacheRead: number
  // The tokens it generated.
  output: number
  // The number of tool calls the agent had made when the request was sent.
  steps: number
}

// What the details pane shows of one agent beyond its run: all clipped.
export type AgentDetails = {
  // The brief it was given.
  brief: string
  // The last report it gave, or null before its first.
  report: string | null
  // Its latest tool calls, oldest first. Optional: details an earlier version kept have none.
  steps?: AgentStep[]
  // Its model requests, oldest first, the latest KEEP_REQUESTS. Optional as `steps` is.
  requests?: AgentRequest[]
}

// The details pane's tabs.
export type PaneTab = 'overview' | 'brief' | 'steps' | 'tokens' | 'report'

declare module 'claude-code' {
  interface PluginState {
    // `agents` lists the agents the main loop started while the mode was on, newest last.
    // `isExpanded` opens the band's list of them.
    // `note` waits for the next prompt after the band's switch changed the mode.
    // `selected` is the agent the details pane shows: the row pressed last.
    // `details` holds each listed agent's brief, report and steps, by agent id.
    // `showAllSteps` shows every kept step on the Steps tab, not the latest 40;
    // `showRawReport` shows the report as written on the Report tab.
    // `tab` is the details pane's open tab; `openStep` the step (by `n`) whose
    // input and output the Steps tab shows, or null.
    orchestrator: {
      isOn: boolean
      agents: AgentRun[]
      isExpanded: boolean
      note: string | null
      selected: string | null
      details: Record<string, AgentDetails>
      showAllSteps: boolean
      showRawReport: boolean
      tab: PaneTab
      openStep: number | null
    }
  }
}
