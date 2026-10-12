# @openclaw/workflow

Task workflow orchestration MVP for **OpenClaw**.

This plugin takes the parts of OpenMOSS that fit OpenClaw well and keeps them as a plugin-layer workflow system instead of a core runtime rewrite.

## What It Adds

- Tool: `workflow`
- Command: `/workflow`
- CLI: `openclaw workflow ...`
- HTTP routes: `/plugins/workflow/...`
- Browser dashboard at `/plugins/workflow/`
- Prompt guidance via `before_prompt_build`
- SQLite-backed task, subtask, review, and activity tracking

## OpenMOSS Mapping

OpenMOSS concepts that map cleanly into OpenClaw:

- planner -> creates tasks and subtasks
- executor -> claims, starts, and submits subtasks
- reviewer -> approves or rejects submitted work
- patrol -> blocks stale or risky work

What this MVP does not try to copy:

- no separate service
- no new agent registry
- no scoreboard or ranking layer
- no full OpenMOSS-style admin UI

## Install

Local dev:

```bash
openclaw plugins install ./extensions/workflow
cd ./extensions/workflow && pnpm install
```

Restart the gateway afterwards.

Enable it in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      workflow: {
        enabled: true,
        config: {
          dbPath: "~/.openclaw/plugins/workflow/workflow.sqlite",
          roles: {
            planner: ["pm"],
            reviewer: ["qa"],
            patrol: ["ops"]
          },
          staleMinutes: {
            assigned: 30,
            inProgress: 120
          }
        }
      }
    }
  }
}
```

Ready-to-paste sample: [`examples/openclaw.workflow.json5`](/Users/at/code/ai/openclaw/extensions/workflow/examples/openclaw.workflow.json5)

Discord multi-agent plan: [`docs/discord-multi-agent-plan.md`](/Users/at/code/ai/openclaw/extensions/workflow/docs/discord-multi-agent-plan.md)

Discord runbook: [`docs/discord-runbook.zh-CN.md`](/Users/at/code/ai/openclaw/extensions/workflow/docs/discord-runbook.zh-CN.md)

OpenMOSS integration notes: [`docs/openmoss-openclaw-integration.md`](/Users/at/code/ai/openclaw/extensions/workflow/docs/openmoss-openclaw-integration.md)

## Config

Put under `plugins.entries.workflow.config`:

```json5
{
  dbPath: "~/.openclaw/plugins/workflow/workflow.sqlite",
  roles: {
    planner: ["pm"],
    reviewer: ["qa"],
    patrol: ["ops"]
  },
  staleMinutes: {
    assigned: 30,
    inProgress: 120
  }
}
```

Notes:

- agents not listed in `planner` / `reviewer` / `patrol` are treated as `executor`
- `dbPath` can be absolute or `~/...`
- default database path is `~/.openclaw/plugins/workflow/workflow.sqlite`
- the plugin must also be enabled with `plugins.entries.workflow.enabled: true`

## Tool

Tool name: `workflow`

Actions:

- `pull_queue`
- `queue_summary`
- `list_tasks`
- `get_task`
- `create_task`
- `create_subtask`
- `plan_subtasks`
- `list_subtasks`
- `get_subtask`
- `claim_subtask`
- `start_subtask`
- `submit_subtask`
- `review_subtask`
- `block_subtask`
- `reassign_subtask`
- `cancel_subtask`
- `log_activity`

Role guardrails:

- `planner`: create, reassign, cancel
- `executor`: claim, start, submit
- `reviewer`: review
- `patrol`: block

## CLI

```bash
openclaw workflow summary
openclaw workflow tasks list
openclaw workflow tasks create "Ship workflow MVP" --actor pm
openclaw workflow subtasks list --status assigned
openclaw workflow subtasks cancel <subtaskId> --actor pm --summary "scope changed"
```

## HTTP

- `GET /plugins/workflow/` serves HTML in browsers and JSON for non-HTML clients
- `GET /plugins/workflow/`
- `GET /plugins/workflow/queue-summary`
- `GET/POST /plugins/workflow/tasks`
- `GET /plugins/workflow/tasks/:id`
- `POST /plugins/workflow/tasks/:id/plan-subtasks`
- `GET/POST /plugins/workflow/subtasks`
- `GET /plugins/workflow/subtasks/:id`
- `POST /plugins/workflow/subtasks/:id/cancel`
- `GET /plugins/workflow/reviews`
- `GET /plugins/workflow/activity`

## Discord Quick Start

在 Discord 里，`workflow` 现在有一个插件命令入口：

- `/workflow`
- `/workflow dashboard`
- `/workflow planner`
- `/workflow executor`
- `/workflow reviewer`
- `/workflow ops`
- `/workflow queue`
- `/workflow review`
- `/workflow blocked`
- `/workflow high-risk`
- `/workflow create-task "任务名" --description "..."`
- `/workflow create-subtask <taskId> "子任务名" --assigned dev1`
- `/workflow plan-subtasks <taskId> --persist`
- `/workflow cancel-subtask <subtaskId> --summary "..."`
- `/workflow claim-subtask <subtaskId>`
- `/workflow start-subtask <subtaskId>`
- `/workflow submit-subtask <subtaskId> --commit abc1234 --test "..." --delivery "..."`
- `/workflow handoff-subtask <subtaskId> --handoff "..."`
- `/workflow review-subtask <subtaskId> --result approved --score 5`
- `/workflow block-subtask <subtaskId> --summary "..."`
- `/workflow unblock-subtask <subtaskId> --resolution "..." --assigned dev1`

常用短别名：

- `/workflow plan <taskId> ...`
- `/workflow claim <subtaskId>`
- `/workflow start <subtaskId>`
- `/workflow submit <subtaskId> ...`
- `/workflow handoff <subtaskId> ...`
- `/workflow approve <subtaskId> --score 5`
- `/workflow reject <subtaskId> --score 2 --issues "..."`
- `/workflow block <subtaskId> ...`
- `/workflow unblock <subtaskId> ...`

推荐流程：

1. 主频道先执行 `/workflow` 看总览和看板链接
2. 为 `main` / `dev1` / `qa` / `ops` 分别开线程
3. 在线程里用 `/focus <agentId>` 绑定角色
4. planner 线程做任务创建和拆分，executor 线程做提交，reviewer 线程做评审，ops 线程看阻塞和高风险

注意：

- `/workflow` 当前优先提供入口、说明和治理视图
- 当前已支持最小写命令：`create-task`、`plan-subtasks`、`cancel-subtask`
- 当前已支持 executor 写命令：`claim-subtask`、`start-subtask`、`submit-subtask`、`handoff-subtask`
- 当前已支持 reviewer / patrol 写命令：`review-subtask`、`block-subtask`、`unblock-subtask`
- 这些写命令优先使用当前线程绑定的 planner agent；未绑定时可显式传 `--actor <agentId>`
- 对 executor 来说，最自然的用法是先在执行线程 `/focus dev1`，再直接执行这些命令
- 复杂状态流转仍建议配合 agent + `workflow` tool / dashboard

## Notes

- The plugin reuses OpenClaw agent ids instead of creating a separate workflow identity system.
- Reviews move work to `done` or `rework`.
- Queue summaries are intended to be cheap enough for prompt-time guidance.
- `plan_subtasks` lets planners turn a bullet plan into subtask drafts, and optionally persist them.
- the dashboard can now call the same planning flow directly from the browser
- This is an MVP plugin surface for validating workflow orchestration inside OpenClaw before any core changes are considered.
- ACP runtimes such as `codex` and `claude` fit best as executor-style agents alongside this plugin, while workflow control stays in OpenClaw.
- MCP servers for ACP agents should be configured under `plugins.entries.acpx.config.mcpServers`.

## Quick Verify

```bash
openclaw workflow summary
openclaw workflow tasks create "Ship workflow MVP" --actor pm
openclaw workflow tasks list
```
