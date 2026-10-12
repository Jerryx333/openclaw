# OpenMOSS × OpenClaw Integration Notes

This note records the engineering conclusion from comparing OpenMOSS with the local OpenClaw `workflow` plugin implementation.

## Core conclusion

OpenMOSS is best understood as a workflow-governance layer built on top of OpenClaw, not as a replacement for OpenClaw runtime.

That means the right integration path is:

- keep OpenClaw as the runtime, channel, session, and tool substrate
- move the most valuable OpenMOSS workflow concepts into an OpenClaw plugin
- validate with an MVP plugin before considering any core changes

## What OpenMOSS contributes conceptually

OpenMOSS adds organizational structure around four roles:

- `planner`
- `executor`
- `reviewer`
- `patrol`

It also adds:

- task governance
- review/rework loops
- blocked/stale patrol
- activity visibility
- optional scoring and ranking
- notifications
- recurring task ideas
- a management UI

## What maps cleanly into OpenClaw

The following concepts fit well inside a plugin:

- tasks and subtasks
- subtask state transitions
- review and rework
- patrol blocking
- activity logs
- role-specific prompt guidance
- queue summaries
- planner-driven decomposition
- a thin dashboard

## What should not be copied first

These are intentionally out of MVP scope:

- separate FastAPI service
- separate agent registry
- score / leaderboard system
- recurring tasks
- full OpenMOSS-style admin console
- full Task -> Module -> Subtask hierarchy

## Current OpenClaw workflow plugin status

The local plugin already implements:

- SQLite-backed `tasks`, `subtasks`, `reviews`, `activity_logs`
- role-aware `workflow` tool
- planner action `plan_subtasks`
- HTTP routes under `/plugins/workflow`
- browser dashboard at `/plugins/workflow/`
- prompt hook via `before_prompt_build`
- minimal CLI surface

## ACP and MCP fit

OpenMOSS-style workflow governance and ACP runtimes solve different layers:

- `workflow` handles task governance
- ACP agents such as `codex` and `claude` handle execution runtime
- `mcpServers` extend ACP runtimes with extra tools

Current OpenClaw already supports ACP runtimes through `acp + acpx`, and the
docs explicitly cover harness ids such as:

- `codex`
- `claude`
- `opencode`
- `gemini`
- `pi`

MCP server injection is handled by:

- `plugins.entries.acpx.config.mcpServers`

Recommended interpretation:

- keep `main` / `pm` / `qa` / `ops` in the workflow-governance layer
- use ACP agents for executor-style code work
- keep workflow actions such as `create_task`, `plan_subtasks`, and review
  inside OpenClaw plugin flows instead of pushing them directly into ACP
  harnesses

## Recommended next steps

1. Stabilize Discord multi-agent routing with thread bindings.
2. Keep phase 1 on single-executor code changes.
3. Add an explicit `ops` trigger path via heartbeat or cron.
4. Define git coordination before enabling multi-executor repo writes.
5. Revisit modules, recurring tasks, and scoring only after the workflow loop is proven useful.
