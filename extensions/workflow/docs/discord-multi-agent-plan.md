# Discord 多 Agent 方案

这份方案面向当前 `workflow` 插件的使用场景，目标是在 **同一个 Discord 服务器** 里，把 OpenClaw 工作流拆成多个明确角色，而不是把所有规划、执行、评审、巡检都塞进一个会话里。

## 结论

推荐先走这条路线：

1. 一个 Discord bot 账号
2. 一个主频道
3. 多个 OpenClaw agent
4. 用 Discord 线程把不同 agent 绑定到不同工作流角色

这是当前成本最低、最接近 OpenMOSS 工作方式、也最容易维护的方案。

## 推荐角色

- `main`
  作用：主对话入口、planner、任务创建、任务拆分
- `qa`
  作用：reviewer，只负责评审和驳回
- `ops`
  作用：patrol，只负责巡检、阻塞和超时治理
- `dev1` / `dev2`
  作用：executor，负责 claim/start/submit 子任务

注意：

- `workflow` 插件里的 `planner / reviewer / patrol / executor` 是**插件角色**
- `main / qa / ops / dev1` 是 **OpenClaw agent id**
- 两者不是同一个概念
- 这里采用的是“主映射”关系，而不是严格一一映射
- 例如 `planner` 可以先映射到 `main`，后续也可以扩展到 `pm`

## 为什么推荐“单频道 + 多线程”

优点：

- 保持同一个 Discord 群作为总入口
- 每个线程可以绑定到独立 agent，会话不串
- 适合 planner / reviewer / patrol 并行工作
- 比“一堆频道”更接近任务协同场景
- 不需要先维护多个 Discord bot token

不推荐一开始就上“多 bot 多账号”：

- 配置更重
- 运营上更乱
- 你当前要验证的是工作流闭环，不是多账号编排

## 已知限制

### 1. 单 bot 身份展示

单 bot 方案下，不同 agent 在 Discord 里默认共用同一个 bot 名称和头像。

这不会影响路由，但会影响辨识度。

当前建议：

- 用线程名区分角色，例如 `规划-main`、`评审-qa`、`巡检-ops`
- 必要时在系统提示或回复模板里加角色前缀
- 在验证期先接受“同头像不同线程”的成本

### 2. Discord 线程归档

Discord 线程的自动归档和 OpenClaw 的 `threadBindings.idleHours` 不是一回事。

当前按保守策略处理：

- 被 Discord 归档的线程，视为“需要人工恢复”的线程
- 重新打开线程后，如果绑定行为异常，手动再执行一次 `/focus <target>`
- 不把“线程自动归档后绑定一定自动恢复”当成现阶段假设

### 3. 本方案不是高可用设计

当前方案目标是验证 workflow 协作闭环，不是高可用生产架构。

已知现实：

- 单 bot 是单点
- 单 gateway 也是单点
- 某个 agent 卡住时，需要人工干预或后续补调度

## 方案分层

### 第一阶段：最小可用

目标：先把 workflow 插件真正跑起来，并验证“Discord 里可以完成任务创建、拆分、执行、评审”的最小闭环。

结构：

- 主频道：`#workflow`
- 主频道默认路由到 `main`
- `main` 负责创建 task、`plan_subtasks`
- 执行工作先仅允许一个 executor 触碰代码仓库

阶段 1 退出条件：

- 可以在 Discord 主频道创建 task
- 可以在 Discord 主频道调用 `plan_subtasks`
- 至少有 1 个 subtask 完成 `claim -> start -> submit -> review`
- 全流程至少连续跑通 3 次
- 不引入多 executor 并发改代码

### 第二阶段：线程化角色拆分

目标：在同一个群里用多 agent。

结构：

- 主频道：`#workflow`
- 线程 A：绑定 `main`，用于规划
- 线程 B：绑定 `qa`，用于评审
- 线程 C：绑定 `ops`，用于巡检
- 可选线程 D/E：绑定 `dev1` / `dev2`，用于执行

推荐操作方式：

- 主频道里只做总控
- 具体子任务和评审都进入对应线程
- 用 `/focus <target>` 把线程绑定到目标 agent
- 用 `/agents` 查看当前线程绑定状态

阶段 2 退出条件：

- `main`、`qa`、`ops` 至少各自有 1 个专属线程
- review 和巡检不再在主频道完成，而是在对应线程完成
- 至少连续 1 周使用过程中，不需要频繁手动重建线程绑定
- 能明确记录 3 次以上实际协作案例

### 第三阶段：按频道固定路由

目标：把群结构长期稳定化。

结构示例：

- `#workflow-control` -> `main`
- `#workflow-review` -> `qa`
- `#workflow-ops` -> `ops`
- `#workflow-dev` -> `dev1`

阶段 3 退出条件：

- 角色分工和频道职责基本稳定
- `/focus` 只作为补充手段，不再依赖它作为日常主流程
- 已经明确是否需要多 bot 或 ACP

## 推荐配置思路

### 1. 增加独立 agent

建议至少定义这些 agent：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        workspace: "~/.openclaw/workspace-main",
      },
      {
        id: "qa",
        workspace: "~/.openclaw/workspace-qa",
      },
      {
        id: "ops",
        workspace: "~/.openclaw/workspace-ops",
      },
      {
        id: "dev1",
        workspace: "~/.openclaw/workspace-dev1",
      }
    ]
  }
}
```

### 2. 启用 Discord 线程绑定

```json5
{
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0, // 0 表示不设置硬性最大年龄
      },
    },
  },
}
```

说明：

- 这里只写 Discord 这一层，避免和全局 `session.threadBindings` 重复
- 如果以后多个频道都要统一线程绑定策略，再上升到 `session.threadBindings`

这样你才能在 Discord 里使用：

- `/focus <target>`
- `/unfocus`
- `/agents`

### 3. 给主频道一个默认路由

如果你先只想把主频道固定给 `main`：

```json5
{
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "DISCORD_CHANNEL_ID" },
      },
    },
  ],
}
```

### 4. 把 workflow 插件角色映射到 agent id

推荐映射：

```json5
{
  plugins: {
    entries: {
      workflow: {
        enabled: true,
        config: {
          roles: {
            planner: ["main", "pm"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
      },
    },
  },
}
```

这意味着：

- `main` 可以直接在 Discord 里 `create_task` / `plan_subtasks`
- `qa` 只能走 `review_subtask`
- `ops` 只能走 `block_subtask`
- `dev1` 这类未显式列出的 agent 自动视为 `executor`

### 5. 把 Codex / Claude Code 作为执行层接进来

推荐做法不是让它们替代 `main / qa / ops`，而是把它们接成执行型 ACP agent。

建议分工：

- `main` / `pm` 负责 task 创建和拆分
- `qa` 负责评审
- `ops` 负责巡检
- `codex` / `claude` 负责具体代码执行

接入重点：

- `acp.enabled = true`
- `acp.backend = "acpx"`
- `agents.list` 中加入 `codex` / `claude`
- `channels.discord.threadBindings.spawnAcpSessions = true`

这样在 Discord 线程里可以直接拉起：

```text
/acp spawn codex --mode persistent --thread auto --cwd /Users/at/code/ai/openclaw
/acp spawn claude --mode persistent --thread auto --cwd /Users/at/code/ai/openclaw
```

推荐顺序：

1. 主频道由 `main` 创建 task
2. `main` 调 `plan_subtasks`
3. 为某个 subtask 开线程
4. 在线程里 `/acp spawn codex` 或 `/acp spawn claude`
5. 执行完成后回到 `qa` / `main` 做 review 和收尾

这比“让 Codex/Claude 直接承担全部 workflow 控制”更稳，因为当前 `workflow` 是治理层，ACP agent 是执行层。

### 6. MCP 的接入位置

MCP 不挂在 `workflow` 插件上，而是挂在 `acpx` 上：

- `plugins.entries.acpx.config.mcpServers`

这允许后续给 `codex` / `claude` 增加额外工具，而不需要改 `workflow` 插件架构。

## Git 并发策略

这是多 executor 方案里必须最早补清楚的部分。

### 阶段 1 规则

- 同一时间只允许 1 个 executor 改动主仓库
- 其他 agent 可以参与规划、评审、巡检，但不并发提交代码
- 先验证 workflow 闭环，再引入多 executor

### 阶段 2 规则

- 每个 subtask 对应一个独立分支
- 分支命名建议：`workflow/<subtask-id>-<agent-id>`
- executor 完成后只提交到自己的分支，不直接推主分支
- review 通过后再统一合并

### 阶段 3 规则

- 如果多个 executor 必须同时改同一个 repo：
  - planner 负责拆分 write scope
  - 一个 subtask 尽量对应一组相对独立的文件
  - 避免两个 executor 同时改同一核心文件
- 冲突处理默认由 planner 或指定 integrator 统一处理
- 不要求 executor 自己解决跨分支全量冲突

当前建议：

- 在真正进入多 executor 之前，先把“单 executor + 多角色协作”跑稳

## ops 触发机制

`ops` 是主动角色，不能只靠用户在 Discord 里 @ 它。

推荐顺序：

### 第一阶段

- 手工触发
- 由你在 Discord 里明确让 `ops` 线程执行一次巡检

### 第二阶段

- 用 OpenClaw heartbeat 或 cron 定时触发
- 固定让 `ops` 周期性执行：
  - `queue_summary`
  - `pull_queue`
  - stale 检查

### 第三阶段

- 如果巡检逻辑稳定，再考虑外部 scheduler 或 ACP 常驻会话

当前建议：

- 不要把 `ops` 设计成永远在线智能体
- 先把它当作“定时被唤醒的巡检代理”

## 错误处理与降级

### 1. 某个 agent 无响应

- 不自动切换角色
- 由 `main` 接管，或者重新在对应线程触发一次
- 如果 `qa` 卡住，review 暂时回退给 `main`

### 2. 线程绑定异常或丢失

- 先用 `/agents` 查看当前绑定状态
- 需要时重新执行 `/focus <target>`
- 不依赖“重启后一定保持线程绑定”作为 MVP 假设

### 3. bot / gateway 故障

- 视为单点故障
- 当前阶段接受这个事实
- 恢复后优先检查：
  - Discord 路由是否正常
  - `/plugins/workflow/queue-summary` 是否可访问
  - 线程绑定是否仍可手工恢复

### 4. review 超时

- 不自动跳过 review
- 如果 review 超过约定时间，由 `main` 重新分配或人工接管

## Discord 里的实际使用方式

### 方案 A：先在主频道里用 `main`

在 `#workflow` 里直接让 bot：

- 创建任务
- 拆分任务
- 查看队列

适合初期验证。

### 方案 B：线程分角色

推荐操作顺序：

1. 在主频道创建 task
2. 在主频道拆分 subtasks
3. 新开一个线程，执行 `/focus qa`
4. 让这个线程专门处理 review
5. 再开一个线程，执行 `/focus ops`
6. 让这个线程专门处理 stale / blocked / queue health

这条路线最接近 OpenMOSS 的协作形态。

### 方案 C：后续再引入 subagent / ACP

如果后面你希望执行 agent 真正“并发”，可以再引入：

- subagent 线程
- ACP agent 绑定

但这应该放在 workflow MVP 验证之后，不建议一开始就上。

## 阶段验收标准

### 阶段 1 验收

- 至少 3 个任务闭环跑通
- 每个任务至少包含 task、subtask、review 记录
- 没有出现“状态全靠对话记忆，没写回 workflow”的情况

### 阶段 2 验收

- 至少 2 个角色线程长期使用
- 线程绑定可以稳定维持日常协作
- review、ops 已经不依赖主频道串行完成

### 阶段 3 验收

- 已形成固定频道或固定线程职责
- 已明确是否需要多 bot、多账号或 ACP 常驻
- 已明确 git 并发协作规则，并能执行

## 推荐落地顺序

1. 先保持一个 Discord bot，不拆账号
2. 新增 `qa`、`ops`、`dev1` 这几个 agent
3. 开启 Discord `threadBindings`
4. 先把主频道固定到 `main`
5. 用线程 + `/focus` 跑通多 agent 分工
6. 确认流程稳定后，再决定是否需要“按频道固定 agent”或“多 bot”

## 当前建议

对你现在这套本地配置，建议下一步做这五件事：

1. 增加 `qa`、`ops`、`dev1` agent
2. 开启 Discord `threadBindings`
3. 保持 `main` 作为 planner 入口，在主频道或主线程里创建和拆分任务
4. 阶段 1 先坚持“单 executor 改代码”，不要急着放开多 executor
5. 给 `ops` 增加一个最小定时触发机制
