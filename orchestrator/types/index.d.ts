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

// What the details pane shows of one agent beyond its run: both clipped.
export type AgentDetails = {
  // The brief it was given.
  brief: string
  // The last report it gave, or null before its first.
  report: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // `agents` lists the agents the main loop started while the mode was on, newest last.
    // `isExpanded` opens the band's list of them.
    // `note` waits for the next prompt after the band's switch changed the mode.
    // `selected` is the agent the details pane shows: the row pressed last.
    // `details` holds each listed agent's brief and report, by agent id.
    orchestrator: {
      isOn: boolean
      agents: AgentRun[]
      isExpanded: boolean
      note: string | null
      selected: string | null
      details: Record<string, AgentDetails>
    }
  }
}
