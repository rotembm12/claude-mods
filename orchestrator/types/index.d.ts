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
}

// What the details pane shows of one agent beyond its run: all clipped.
export type AgentDetails = {
  // The brief it was given.
  brief: string
  // The last report it gave, or null before its first.
  report: string | null
  // Its latest tool calls, oldest first. Optional: details an earlier version kept have none.
  steps?: AgentStep[]
}

declare module 'claude-code' {
  interface PluginState {
    // `agents` lists the agents the main loop started while the mode was on, newest last.
    // `isExpanded` opens the band's list of them.
    // `note` waits for the next prompt after the band's switch changed the mode.
    // `selected` is the agent the details pane shows: the row pressed last.
    // `details` holds each listed agent's brief, report and steps, by agent id.
    // `showAllSteps` and `showFullBrief` open the pane's long sections whole.
    orchestrator: {
      isOn: boolean
      agents: AgentRun[]
      isExpanded: boolean
      note: string | null
      selected: string | null
      details: Record<string, AgentDetails>
      showAllSteps: boolean
      showFullBrief: boolean
    }
  }
}
