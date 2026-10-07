export type Saved = { topics: string[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'session-topics': { topics: string[]; seed: string | null; isMinimized: boolean }
  }
}
