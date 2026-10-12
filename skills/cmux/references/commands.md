# cmux command notes

## Concept mapping

Use these mappings when translating user intent:

- `window`: a macOS window
- `workspace`: a sidebar entry; often what users informally call a tab
- `pane`: a split region inside a workspace
- `surface`: a tab inside a pane
- `panel`: the content implementation, usually terminal or browser

Approximate `tmux` translation:

- `tmux window` is often closest to `cmux workspace`
- `tmux pane` is still close to `cmux pane`
- `tmux session` has no exact `cmux` equivalent; users may mean an app window, a workspace, or a terminal surface

## Read-only commands

Use these first:

```bash
cmux list-windows
cmux current-window
cmux list-workspaces
cmux current-workspace
cmux list-panes
cmux list-pane-surfaces --workspace workspace:1 --pane pane:2
cmux tree --all
cmux read-screen --workspace workspace:1 --lines 80
```

## Common write commands

```bash
cmux new-window
cmux new-workspace --name "api" --cwd .
cmux new-split right
cmux new-pane --direction down --workspace workspace:1
cmux select-workspace --workspace workspace:2
cmux focus-pane --pane pane:2 --workspace workspace:1
cmux close-workspace --workspace workspace:2
```

## Browser and automation

```bash
cmux new-surface --type browser --pane pane:1 --url http://localhost:3000
cmux browser surface:2 eval --script "window.location.href"
cmux browser surface:2 wait --function "window.__appReady === true"
```

## Practical answer pattern

When the user asks a live-state question:

1. Run `env | rg '^CMUX'`
2. Run `cmux tree --all`
3. If counts are needed, supplement with `cmux list-windows`, `cmux list-workspaces`, and `cmux list-panes --workspace ...`
4. Answer with exact counts and names

When the user asks a conceptual question:

1. Explain the `Window -> Workspace -> Pane -> Surface` hierarchy
2. Call out where `cmux` differs from `tmux`
3. Provide the shortest command that proves the answer on the live system
