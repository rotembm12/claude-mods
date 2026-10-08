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
}

declare module 'claude-code' {
  interface PluginState {
    // `agents` lists the agents the main loop started while the mode was on, newest last.
    // `isExpanded` opens the band's list of them.
    // `note` waits for the next prompt after the band's switch changed the mode.
    orchestrator: { isOn: boolean; agents: AgentRun[]; isExpanded: boolean; note: string | null }
  }
}
