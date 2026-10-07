export type Saved = { isOn: boolean; at: number }

declare module 'claude-code' {
  interface PluginState {
    // `spawns` counts the agents the main loop started while the mode was on, by model tier.
    // `note` waits for the next prompt after the band's switch changed the mode.
    orchestrator: { isOn: boolean; spawns: Record<string, number>; note: string | null }
  }
}
