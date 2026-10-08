# claude-mods

This repository is a Claude Code plugin marketplace named `rotem-mods`. It holds three mods (plugins that add panes, bands, and commands to Claude Code).

| Mod | What it does |
| --- | --- |
| `context-usage` | Shows how full the context window of the session is, in a band above the prompt. The `/context-bar` command toggles the detail view. |
| `session-topics` | Shows the topics of the session and a color for each session above the prompt. You can tell side-by-side sessions apart. |
| `orchestrator` | Makes the session delegate work to subagents. A subagent runs on Haiku for simple, repetitive tasks and on Sonnet for hard or long tasks, never on Opus or Fable. The `details` button in its band lists the running and past subagents. Use `/orchestrator on`, `/orchestrator off`, or `/orchestrator status`. |

## Install

1. Add the marketplace in Claude Code:

   ```
   /plugin marketplace add rotembm12/claude-mods
   ```

2. Install each mod that you want:

   ```
   /plugin install context-usage@rotem-mods
   /plugin install session-topics@rotem-mods
   /plugin install orchestrator@rotem-mods
   ```

## Update

To get new versions of the mods, run this command:

```
/plugin marketplace update rotem-mods
```
