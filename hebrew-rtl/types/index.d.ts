/** What the mod keeps for the session: whether the RTL view is on. */
export type HebrewRtlState = { isEnabled: boolean }

declare module 'claude-code' {
  interface PluginState {
    'hebrew-rtl': { isEnabled: boolean }
  }
}
