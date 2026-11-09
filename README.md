# claude-mods

This repository is a Claude Code plugin marketplace named `rotem-mods`. It holds three mods (plugins that add panes, bands, and commands to Claude Code).

| Mod | What it does |
| --- | --- |
| `context-usage` | Shows how full the context window of the session is, in a band above the prompt. The `/context-bar` command toggles the detail view. |
| `session-topics` | Shows the topics of the session and a color for each session above the prompt. You can tell side-by-side sessions apart. |
| `orchestrator` | Makes the session delegate work to subagents. A subagent runs on Haiku 5.5 for simple, repetitive tasks and on Sonnet 5.5 for hard or long tasks, never on Opus or Fable. The mod pins both tiers to their 5.5 models (`claude-haiku-5-5`, `claude-sonnet-5-5`). The orchestrator splits work into tasks of about 150K tokens of subagent context each. The `details` button in its band lists the running and past subagents; click a row to open the agent inspector, a pane in five tabs (keys 1 to 5): Overview (status, model, the outcome at a glance, a token chart and a timeline of its calls, and its work as phases), Brief (the whole brief, in a card for each of its sections), Steps (every call it made; press one to read its input and output), Tokens (how its context grew against the 150K budget, the biggest jumps and what caused them, cache use and output) and Report (the report split into answer, changes, evidence and open points). Desktop draws each section as a card and the charts as still SVG, so scrolling neither flickers nor jumps; the terminal draws text twins. A scout runs on Haiku unless the orchestrator asks for Sonnet. Use `/orchestrator on`, `/orchestrator off`, or `/orchestrator status`. |

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
