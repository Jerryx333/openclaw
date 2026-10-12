# Workflow Discord 实战手册

这份文档不是设计方案，而是给操作者直接照着跑的实际手册。

目标：

1. 在同一个 Discord 服务器里启用多 Agent 协作
2. 让 `workflow` 插件承担任务治理
3. 用 `main / dev1 / qa / ops` 角色跑通一个完整闭环

适用前提：

- `workflow` 插件已经安装并启用
- Discord channel 已接到 OpenClaw
- Discord `threadBindings` 已开启
- 你已经定义了至少这些 agent：`main`、`dev1`、`qa`、`ops`

## 一、推荐角色

- `main`
  作用：planner，负责创建 task、拆 subtask、总体协调
- `dev1`
  作用：executor，负责认领、开始、提交、交接
- `qa`
  作用：reviewer，负责 approve / reject
- `ops`
  作用：patrol，负责 block / unblock 和巡检

插件角色映射建议：

```json5
{
  plugins: {
    entries: {
      workflow: {
        enabled: true,
        config: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"]
          }
        }
      }
    }
  }
}
```

说明：

- 没有显式映射到 `planner / reviewer / patrol` 的 agent，默认都算 `executor`
- 所以 `dev1` 不用额外写到 `roles` 里

## 二、Discord 结构建议

最简单的结构：

- 主频道：`#workflow`
- 线程 1：`规划-main`
- 线程 2：`执行-dev1`
- 线程 3：`评审-qa`
- 线程 4：`巡检-ops`

推荐原则：

- 主频道只做总控，不做具体执行
- 每个线程长期绑定一个 agent
- 不要把 planner、executor、reviewer 混在一个线程里

## 三、首次进入怎么做

### 1. 在主频道确认插件活着

先执行：

```text
/workflow
```

你应该能看到：

- Dashboard 链接
- 角色说明
- 可用子命令

如果这里没有 `/workflow`：

- 重启 OpenClaw gateway / Discord monitor
- 确认插件已启用
- 确认 Discord slash command 已重新部署

### 2. 给线程绑定 agent

在各自线程里执行：

```text
/focus main
/focus dev1
/focus qa
/focus ops
```

建议：

- 在 `规划-main` 线程执行 `/focus main`
- 在 `执行-dev1` 线程执行 `/focus dev1`
- 在 `评审-qa` 线程执行 `/focus qa`
- 在 `巡检-ops` 线程执行 `/focus ops`

可以用下面命令检查：

```text
/agents
```

如果线程绑定丢了：

- 重新打开线程
- 再执行一次 `/focus <agentId>`

## 四、最小闭环怎么跑

下面是一条完整闭环。

### 第一步：planner 创建任务

在 `规划-main` 线程：

```text
/workflow create-task "接入 Discord workflow"
```

返回里会有：

- `taskId`

记下这个 `taskId`。

### 第二步：planner 拆任务

方式 A：手工创建一个 subtask

```text
/workflow create-subtask <taskId> "实现命令入口" --assigned dev1 --priority high
```

方式 B：批量拆分

```text
/workflow plan <taskId> --plan "实现命令入口 | owner: dev1 ; 补测试 | owner: dev1 ; 做评审 | owner: qa" --persist
```

建议：

- 简单任务用 `create-subtask`
- 一个 task 需要拆 2 个以上子任务时用 `plan`

### 第三步：executor 认领并开始

在 `执行-dev1` 线程：

```text
/workflow claim <subtaskId>
/workflow start <subtaskId>
```

说明：

- 如果 subtask 已经明确分配给 `dev1`，`claim` 也可以执行，主要用于把会话正式绑到当前执行者
- `start` 后状态会进入 `in_progress`

### 第四步：需要交接时记录 handoff

如果执行中需要先记录现场，再交给别人继续：

```text
/workflow handoff <subtaskId> --handoff "state captured before review" --commit abc1234 --test "vitest passed"
```

说明：

- `handoff` 不是提交评审
- 它只是把当前上下文、测试和 commit 记录到子任务里

### 第五步：executor 提交评审

在 `执行-dev1` 线程：

```text
/workflow submit <subtaskId> --commit abc1234 --change "workflow command shipped" --test "vitest passed" --delivery "ready for QA"
```

提交规则：

- `--test` 必填
- `--delivery` 必填
- `--commit` 和 `--change` 至少有一个

提交后状态会进入：

- `review`

### 第六步：reviewer 审核

在 `评审-qa` 线程：

通过：

```text
/workflow approve <subtaskId> --score 5 --comment "OK to merge"
```

驳回：

```text
/workflow reject <subtaskId> --score 2 --issues "missing tests" --reassign dev1
```

说明：

- `approve` 本质上是 `review-subtask --result approved`
- `reject` 本质上是 `review-subtask --result rejected`
- 驳回时必须写 `--issues`

### 第七步：ops 处理阻塞

如果执行卡住，在 `巡检-ops` 线程：

标记阻塞：

```text
/workflow block <subtaskId> --summary "waiting on API token"
```

解除阻塞：

```text
/workflow unblock <subtaskId> --resolution "token ready" --assigned dev1
```

说明：

- `block` 一般由 `ops` 或巡检角色使用
- `unblock` 时可以顺手重新指定 owner

## 五、日常查看哪些命令

总览：

```text
/workflow queue
```

看待评审：

```text
/workflow review
```

看阻塞：

```text
/workflow blocked
```

看高风险：

```text
/workflow high-risk
```

打开 Dashboard：

```text
/workflow dashboard
```

## 六、最推荐的日常节奏

每天最实用的节奏是：

1. `main` 在线程里看 `/workflow queue`
2. `main` 创建 task / subtask
3. `dev1` 在线程里 `claim -> start -> submit`
4. `qa` 在线程里 `approve / reject`
5. `ops` 看 `blocked / high-risk`

如果只想先验证最小闭环，不要一开始就上多 executor 并发改代码。

推荐先用：

- 一个 planner
- 一个 executor
- 一个 reviewer
- 一个 ops

先连续跑通 3 次完整闭环，再考虑 `dev2`、`codex`、`claude` 等更多执行者。

## 七、常见报错怎么理解

### 1. 提示“找不到 planner/reviewer/patrol/executor agent”

通常是：

- 当前线程没有 `/focus`
- 或者你用错了角色线程

处理：

```text
/focus <agentId>
```

### 2. 提示某个 agent “不是 planner/reviewer/patrol”

通常是：

- `workflow.roles` 配置没对上
- 或者在线程里 focus 到了错误 agent

先检查：

- `plugins.entries.workflow.config.roles`
- 当前线程的 `/focus`

### 3. submit 失败

最常见原因：

- 没给 `--test`
- 没给 `--delivery`
- `--commit` 和 `--change` 都没给

按最稳妥的写法补齐：

```text
/workflow submit <subtaskId> --commit abc1234 --change "..." --test "..." --delivery "..."
```

### 4. 线程好像失忆了

通常是：

- 线程被 Discord 归档过
- 绑定失效

处理：

```text
/focus <agentId>
```

## 八、给你的一条最短上手路径

如果你现在只想马上试一次，照下面做：

1. 在 Discord 主频道确认 `/workflow` 能出来
2. 开 4 个线程：`main`、`dev1`、`qa`、`ops`
3. 分别执行 `/focus main`、`/focus dev1`、`/focus qa`、`/focus ops`
4. 在 `main` 线程执行：

```text
/workflow create-task "试跑 workflow"
/workflow create-subtask <taskId> "实现一个最小改动" --assigned dev1
```

5. 在 `dev1` 线程执行：

```text
/workflow claim <subtaskId>
/workflow start <subtaskId>
/workflow submit <subtaskId> --change "done" --test "manual check passed" --delivery "ready for QA"
```

6. 在 `qa` 线程执行：

```text
/workflow approve <subtaskId> --score 5 --comment "pass"
```

到这里，你就已经跑完了一次最小闭环。
