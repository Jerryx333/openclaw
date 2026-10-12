---
name: cmux
description: Inspect, explain, and operate `cmux` windows, workspaces, panes, and surfaces from the CLI. Use when the user mentions `cmux`, asks how the current terminal layout works, wants counts or status for live `cmux` state, needs help mapping `cmux` terms to `tmux`-like concepts, or wants common `cmux` actions such as listing windows, selecting workspaces, splitting panes, reading screens, sending input, or moving workspaces between windows.
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "os": ["darwin"],
        "requires": { "bins": ["cmux"] },
        "install":
          [
            {
              "id": "brew-cmux",
              "kind": "brew-cask",
              "tap": "manaflow-ai/cmux",
              "formula": "cmux",
              "bins": ["cmux"],
              "label": "Install cmux (brew cask)",
            },
          ],
      },
  }
---

# cmux

Treat `cmux` as its own model, not as `tmux` with different names. Use `cmux` terms precisely:

```text
Window
  -> Workspace (sidebar entry, often called a tab in UI)
    -> Pane (split region)
      -> Surface (tab within a pane)
        -> Panel (terminal or browser content)
```

When the user says "session", infer carefully. In `cmux`, they often mean one of:
- the current `workspace`
- the current `surface`
- the whole app window

Prefer confirming the live state from the running app instead of answering from memory.

## Quick Start

1. Detect whether the shell is already inside `cmux`:

```bash
env | rg '^CMUX'
command -v cmux
```

If `CMUX_SOCKET` or `CMUX_WORKSPACE_ID` is present, default commands will usually target the current live context.

2. Inspect before mutating:

```bash
cmux list-windows
cmux list-workspaces
cmux list-panes
cmux tree --all
```

Use `cmux tree --all` when you need the fastest accurate snapshot of the full hierarchy.

3. Answer with exact `cmux` terminology. Do not call a `workspace` a `pane`, and do not imply `cmux` has a `tmux session` primitive unless you explicitly say it does not.

## Inspection Workflow

Use this order unless the user requests a specific command:

1. Check environment:

```bash
env | rg '^CMUX'
```

2. Identify top-level state:

```bash
cmux list-windows
cmux list-workspaces
cmux current-workspace
```

3. Inspect pane layout:

```bash
cmux list-panes
cmux list-panes --workspace workspace:2
cmux tree --all
```

4. Inspect terminal contents only when needed:

```bash
cmux read-screen --workspace workspace:1 --lines 80
cmux read-screen --surface surface:2 --scrollback --lines 200
```

5. Report counts explicitly:
- number of windows
- number of workspaces
- number of panes per workspace
- current focused pane/workspace if visible in output

## Common Operations

Create:

```bash
cmux new-window
cmux new-workspace --name "server" --cwd .
cmux new-split right
cmux new-split down --workspace workspace:1
cmux new-surface --type browser --pane pane:2 --url http://localhost:3000
```

Navigate and focus:

```bash
cmux current-workspace
cmux select-workspace --workspace workspace:2
cmux focus-pane --pane pane:3 --workspace workspace:2
cmux next-window
cmux previous-window
cmux last-window
```

Move and reorganize:

```bash
cmux move-workspace-to-window --workspace workspace:2 --window window:1
cmux reorder-workspace --workspace workspace:2 --index 0
cmux move-surface --surface surface:3 --pane pane:1 --workspace workspace:1
```

Interact with terminals:

```bash
cmux send --workspace workspace:1 "pnpm dev"
cmux send-key --workspace workspace:1 enter
cmux read-screen --workspace workspace:1 --lines 120
```

User attention and status:

```bash
cmux notify --title "Build done" --body "Tests passed"
cmux trigger-flash --workspace workspace:1
cmux list-notifications
```

## Claude Code Teams

`cmux` still ships a `claude-teams` command:

```bash
cmux claude-teams
```

Treat it as an extra helper, not the core mental model. Most operational questions should still be answered with `window`, `workspace`, `pane`, and `surface`.

## Operating Rules

- Inspect first, mutate second.
- Use `workspace`, `pane`, `surface`, and `window` refs from live output like `workspace:2` or `pane:3`.
- Prefer `cmux tree --all` when the user asks "how many", "where am I", or "what is open".
- Use `--workspace` and `--surface` explicitly when acting outside the current shell context.
- If a command may shift focus or alter layout, say so before running it.
- Do not claim session persistence for live terminal processes after app restart. `cmux` restores layout and metadata, not live terminal app state.

## References

- Read `references/commands.md` for term mapping and command recipes.
- Read `references/keyboard-shortcuts.md` for current keyboard shortcuts.
