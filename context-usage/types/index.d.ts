export type Part = { name: string; color: string; tokens: number }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  parts?: Part[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-usage': { usage: Usage | null; isExpanded: boolean }
  }
}
