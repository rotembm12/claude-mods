# claude-mods

This repository is a Claude Code plugin marketplace named `rotem-mods`. It holds four mods (plugins that add panes, bands, and commands to Claude Code).

| Mod | What it does |
| --- | --- |
| `context-usage` | Shows how full the context window of the session is, in a band above the prompt. The `/context-bar` command toggles the detail view. |
| `session-topics` | Shows the topics of the session and a color for each session above the prompt. You can tell side-by-side sessions apart. |
| `hebrew-rtl` | Draws Hebrew text in the terminal from right to left. Use it in terminals that have no bidi support. The `/rtl` command turns it on and off. |
| `orchestrator` | Makes the session delegate work to subagents and pick a model for each one. Use `/orchestrator on`, `/orchestrator off`, or `/orchestrator status`. |

## Install

1. Add the marketplace in Claude Code:

   ```
   /plugin marketplace add rotembm12/claude-mods
   ```

2. Install each mod that you want:

   ```
   /plugin install context-usage@rotem-mods
   /plugin install session-topics@rotem-mods
   /plugin install hebrew-rtl@rotem-mods
   /plugin install orchestrator@rotem-mods
   ```

## Update

To get new versions of the mods, run this command:

```
/plugin marketplace update rotem-mods
```
