import { resolveGatewayPort } from "../../../src/config/paths.js";
import { resolveControlUiLinks } from "../../../src/commands/onboard-helpers.js";
import type { OpenClawPluginCommandDefinition } from "../../../src/plugins/types.js";
import type { OpenClawPluginApi } from "../api.js";
import { inferWorkflowRole, resolveWorkflowConfig, roleSummary } from "./config.js";
import { getWorkflowStore } from "./db.js";
import { planSubtasksForTask } from "./planner.js";
import type { StageGateCheck, SubtaskRecord } from "./schema.js";

function resolveWorkflowDashboardBaseUrl(api: OpenClawPluginApi): string {
  const cfg = api.runtime.config?.loadConfig?.() ?? api.config ?? {};
  const bind = cfg.gateway?.bind ?? "loopback";
  const links = resolveControlUiLinks({
    port: resolveGatewayPort(cfg),
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost: cfg.gateway?.customBindHost,
    basePath: cfg.gateway?.controlUi?.basePath,
  });
  return new URL("plugins/workflow/", links.httpUrl).toString();
}

function buildWorkflowUrl(baseUrl: string, search: Record<string, string | boolean | undefined>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string" && value.trim()) {
      url.searchParams.set(key, value);
    } else if (typeof value === "boolean") {
      url.searchParams.set(key, value ? "true" : "false");
    }
  }
  return url.toString();
}

function formatAgents(agentIds: string[]): string {
  return agentIds.length > 0 ? agentIds.join(", ") : "未配置";
}

function formatStageChecks(label: string, checks: StageGateCheck[]): string {
  return [
    `${label}:`,
    ...checks.map((item) => `- ${item.label}: ${item.value} / ${item.target} ${item.passed ? "通过" : "未通过"}`),
  ].join("\n");
}

function formatSubtaskRow(item: SubtaskRecord): string {
  const tags: string[] = [];
  tags.push(item.id);
  tags.push(item.name);
  if (item.assigned_agent_id) {
    tags.push(`agent=${item.assigned_agent_id}`);
  }
  tags.push(`status=${item.status}`);
  if (item.latest_commit_ref) {
    tags.push(`commit=${item.latest_commit_ref}`);
  }
  if (item.is_high_risk) {
    tags.push("high-risk");
  }
  return `- ${tags.join(" | ")}`;
}

function formatSubtaskList(title: string, items: SubtaskRecord[], emptyText: string): string {
  return [
    title,
    items.length > 0 ? items.map((item) => formatSubtaskRow(item)).join("\n") : emptyText,
  ].join("\n");
}

function resolveDiscordUsageHint(params: {
  inThread: boolean;
  plannerAgents: string[];
  reviewerAgents: string[];
  patrolAgents: string[];
}): string {
  const planner = params.plannerAgents[0] ?? "main";
  const reviewer = params.reviewerAgents[0] ?? "qa";
  const patrol = params.patrolAgents[0] ?? "ops";

  if (params.inThread) {
    return [
      "当前上下文：你现在就在 Discord 线程里。",
      `建议先用 \`/focus ${planner}\` / \`/focus ${reviewer}\` / \`/focus ${patrol}\` 把线程固定到对应 agent。`,
      "然后把规划、执行、评审、巡检拆到不同线程里跑，避免会话串线。",
    ].join("\n");
  }

  return [
    "当前上下文：你现在不在 Discord 线程里。",
    "建议先在同一个服务器里新建线程，再执行 `/focus <agentId>` 绑定角色线程。",
    "可先用 `/agents` 看 agent 列表和绑定状态。",
  ].join("\n");
}

function buildOverviewText(params: {
  api: OpenClawPluginApi;
  baseUrl: string;
  plannerAgents: string[];
  reviewerAgents: string[];
  patrolAgents: string[];
  inDiscordThread: boolean;
}): string {
  const reviewUrl = buildWorkflowUrl(params.baseUrl, { observationRole: "reviewer" });
  const blockedUrl = buildWorkflowUrl(params.baseUrl, { subtaskStatus: "blocked" });
  const highRiskUrl = buildWorkflowUrl(params.baseUrl, {
    highRisk: true,
    observationHighRisk: true,
  });
  const configuredRoles = roleSummary(params.api.pluginConfig) || "未配置";

  return [
    "Workflow 协作入口",
    "",
    `角色映射：${configuredRoles}`,
    `- planner: ${formatAgents(params.plannerAgents)}`,
    `- reviewer: ${formatAgents(params.reviewerAgents)}`,
    `- patrol: ${formatAgents(params.patrolAgents)}`,
    `- executor: 其他未显式映射的 agent`,
    "",
    "面板入口：",
    `- 总览：${params.baseUrl}`,
    `- 评审视图：${reviewUrl}`,
    `- 阻塞视图：${blockedUrl}`,
    `- 高风险视图：${highRiskUrl}`,
    "",
    "Discord 推荐用法：",
    "1. 主频道先用 `/workflow planner` 看规划流程。",
    "2. 为规划 / 执行 / 评审 / 巡检分别开线程，并用 `/focus <agentId>` 绑定。",
    "3. planner 线程负责建 task / 拆 subtask；executor 线程负责 claim / start / submit；reviewer 线程负责 review；ops 线程处理 blocked / stale。",
    "4. 日常状态用 `/workflow queue`、`/workflow review`、`/workflow blocked`、`/workflow high-risk` 快速查看。",
    "",
    resolveDiscordUsageHint({
      inThread: params.inDiscordThread,
      plannerAgents: params.plannerAgents,
      reviewerAgents: params.reviewerAgents,
      patrolAgents: params.patrolAgents,
    }),
    "",
    "可用子命令：",
    "- `/workflow` 或 `/workflow help`",
    "- `/workflow dashboard`",
    "- `/workflow planner`",
    "- `/workflow executor`",
    "- `/workflow reviewer`",
    "- `/workflow ops`",
    "- `/workflow queue`",
    "- `/workflow review`",
    "- `/workflow blocked`",
    "- `/workflow high-risk`",
    "- `/workflow create-task \"任务名\" [--description ...]`",
    "- `/workflow create-subtask <taskId> \"子任务名\" [...]`",
    "- `/workflow plan-subtasks <taskId> [--persist] [--plan ...]` 或 `/workflow plan <taskId> ...`",
    "- `/workflow cancel-subtask <subtaskId> [--summary ...]`",
    "- `/workflow review-subtask <subtaskId> --result ... --score ...`",
    "- `/workflow approve <subtaskId> --score 5 --comment ...`",
    "- `/workflow reject <subtaskId> --score 2 --issues ...`",
    "- `/workflow block-subtask <subtaskId> --summary ...` 或 `/workflow block <subtaskId> ...`",
    "- `/workflow unblock-subtask <subtaskId> --resolution ...` 或 `/workflow unblock <subtaskId> ...`",
    "- `/workflow claim-subtask <subtaskId>`",
    "- `/workflow start-subtask <subtaskId>`",
    "- `/workflow submit-subtask <subtaskId> --test ... --delivery ...` 或 `/workflow submit <subtaskId> ...`",
    "- `/workflow handoff-subtask <subtaskId> --handoff ...` 或 `/workflow handoff <subtaskId> ...`",
    "",
    "说明：当前已支持 planner / executor / reviewer / patrol 的最小写命令；复杂状态流转仍可继续配合 dashboard。",
  ].join("\n");
}

function buildPlannerText(params: {
  baseUrl: string;
  plannerAgents: string[];
}): string {
  return [
    "Planner 使用说明",
    `推荐 planner agent：${formatAgents(params.plannerAgents)}`,
    "",
    "流程：",
    "1. 在主频道或规划线程先 `/focus <planner-agent>`。",
    "2. 打开 workflow 面板确认 queue、blocked、review 积压。",
    "3. 由 planner 创建 task、拆分 subtasks，并把执行工作分配给 executor 线程。",
    "4. 高风险变更先打风险标签，再进入执行。",
    "",
    `面板：${params.baseUrl}`,
    `阻塞治理：${buildWorkflowUrl(params.baseUrl, { subtaskStatus: "blocked" })}`,
    `评审积压：${buildWorkflowUrl(params.baseUrl, { observationRole: "reviewer" })}`,
  ].join("\n");
}

function buildExecutorText(params: {
  baseUrl: string;
}): string {
  return [
    "Executor 使用说明",
    "",
    "流程：",
    "1. 在执行线程里 `/focus <executor-agent>`。",
    "2. 从 planner 分配的 subtask 开始，按 claim -> start -> submit 推进。",
    "3. 提交时补齐 commit、change summary、test summary、delivery summary；高风险变更补 risk summary。",
    "4. 需要交接时走 handoff；卡住时走 blocked / unblock。",
    "",
    `总览：${params.baseUrl}`,
    `高风险视图：${buildWorkflowUrl(params.baseUrl, { highRisk: true, observationHighRisk: true })}`,
  ].join("\n");
}

function buildReviewerText(params: {
  baseUrl: string;
  reviewerAgents: string[];
}): string {
  return [
    "Reviewer 使用说明",
    `推荐 reviewer agent：${formatAgents(params.reviewerAgents)}`,
    "",
    "流程：",
    "1. 在评审线程里 `/focus <reviewer-agent>`。",
    "2. 优先看 review 队列、高风险项、测试摘要和交付摘要。",
    "3. 通过则推进 done；不通过则明确 issues，打回 rework。",
    "",
    `评审视图：${buildWorkflowUrl(params.baseUrl, { observationRole: "reviewer" })}`,
    `高风险评审：${buildWorkflowUrl(params.baseUrl, {
      currentRole: "reviewer",
      observationRole: "reviewer",
      highRisk: true,
      observationHighRisk: true,
    })}`,
  ].join("\n");
}

function buildOpsText(params: {
  baseUrl: string;
  patrolAgents: string[];
}): string {
  return [
    "Ops / Patrol 使用说明",
    `推荐 patrol agent：${formatAgents(params.patrolAgents)}`,
    "",
    "流程：",
    "1. 在巡检线程里 `/focus <ops-agent>`。",
    "2. 优先看 blocked、stale assigned、stale in_progress、高风险 open 项。",
    "3. 需要时执行 unblock、人工接管、线程重绑或升级处理。",
    "",
    `阻塞视图：${buildWorkflowUrl(params.baseUrl, { subtaskStatus: "blocked" })}`,
    `高风险视图：${buildWorkflowUrl(params.baseUrl, { observationHighRisk: true })}`,
  ].join("\n");
}

function buildQueueText(api: OpenClawPluginApi, baseUrl: string): string {
  const store = getWorkflowStore(api.pluginConfig, api.logger);
  const summary = store.queueSummary();
  const metrics = store.governanceMetrics();
  const stageGates = store.stageGateSummary();

  return [
    "Workflow 队列概览",
    "",
    `tasks: planning=${summary.tasks.planning} | active=${summary.tasks.active} | completed=${summary.tasks.completed} | cancelled=${summary.tasks.cancelled}`,
    `subtasks: pending=${summary.subtasks.pending} | assigned=${summary.subtasks.assigned} | in_progress=${summary.subtasks.in_progress} | review=${summary.subtasks.review} | rework=${summary.subtasks.rework} | blocked=${summary.subtasks.blocked} | done=${summary.subtasks.done}`,
    `stale: assigned=${summary.stale.assigned} | in_progress=${summary.stale.in_progress}`,
    "",
    `治理指标：review_pending=${metrics.review_pending} | blocked=${metrics.blocked} | high_risk_open=${metrics.high_risk_open} | high_risk_review_pending=${metrics.high_risk_review_pending}`,
    "",
    formatStageChecks("阶段门槛 Stage 1", stageGates.stage_1),
    "",
    formatStageChecks("阶段门槛 Stage 2", stageGates.stage_2),
    "",
    `面板：${baseUrl}`,
  ].join("\n");
}

function buildReviewQueueText(api: OpenClawPluginApi, baseUrl: string): string {
  const store = getWorkflowStore(api.pluginConfig, api.logger);
  const items = store.listSubtasks({ status: "review", limit: 8 });
  return [
    formatSubtaskList("待评审子任务", items, "当前没有待评审子任务。"),
    "",
    `评审面板：${buildWorkflowUrl(baseUrl, { observationRole: "reviewer" })}`,
  ].join("\n");
}

function buildBlockedText(api: OpenClawPluginApi, baseUrl: string): string {
  const store = getWorkflowStore(api.pluginConfig, api.logger);
  const items = store.listSubtasks({ status: "blocked", limit: 8 });
  return [
    formatSubtaskList("阻塞子任务", items, "当前没有 blocked 子任务。"),
    "",
    `阻塞面板：${buildWorkflowUrl(baseUrl, { subtaskStatus: "blocked" })}`,
  ].join("\n");
}

function buildHighRiskText(api: OpenClawPluginApi, baseUrl: string): string {
  const store = getWorkflowStore(api.pluginConfig, api.logger);
  const items = store.listObservationSubtasks({ highRisk: true, limit: 8 });
  return [
    formatSubtaskList("高风险观测项", items, "当前没有高风险开放子任务。"),
    "",
    `高风险面板：${buildWorkflowUrl(baseUrl, {
      highRisk: true,
      observationHighRisk: true,
    })}`,
  ].join("\n");
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(value.replace(/\\(["'])/g, "$1"));
  }
  return tokens;
}

function parseCommandArgs(rawArgs: string): {
  action: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const tokens = tokenizeArgs(rawArgs);
  const rawAction =
    tokens[0] === "high" && tokens[1] === "risk" ? "high-risk" : (tokens[0] ?? "help");
  const action = normalizeActionName(rawAction);
  const startIndex = tokens[0] === "high" && tokens[1] === "risk" ? 2 : 1;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).trim().toLowerCase();
    if (!key) {
      continue;
    }
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return { action, positionals, flags };
}

function normalizeActionName(rawAction: string): string {
  const action = rawAction.trim().toLowerCase();
  switch (action) {
    case "":
    case "help":
    case "h":
      return "help";
    case "ui":
    case "board":
      return "dashboard";
    case "q":
      return "queue";
    case "reviews":
      return "review";
    case "risk":
    case "highrisk":
      return "high-risk";
    case "task":
    case "new-task":
    case "new":
      return "create-task";
    case "subtask":
    case "add-subtask":
      return "create-subtask";
    case "plan":
      return "plan-subtasks";
    case "cancel":
      return "cancel-subtask";
    case "approve":
      return "approve";
    case "reject":
      return "reject";
    case "block":
      return "block-subtask";
    case "unblock":
      return "unblock-subtask";
    case "claim":
      return "claim-subtask";
    case "start":
      return "start-subtask";
    case "submit":
      return "submit-subtask";
    case "handoff":
      return "handoff-subtask";
    default:
      return action;
  }
}

function flagString(
  flags: Record<string, string | boolean>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function flagBoolean(
  flags: Record<string, string | boolean>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "n"].includes(normalized)) {
        return false;
      }
    }
  }
  return undefined;
}

function normalizePlannerSource(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("\n")) {
    return trimmed;
  }
  const parts = trimmed.split(/\s*;\s*/).filter(Boolean);
  if (parts.length <= 1) {
    return trimmed;
  }
  return parts.map((item) => `- ${item}`).join("\n");
}

function resolveActingAgent(params: {
  ctxAgentId?: string;
  explicitActor?: string;
  fallbackAgents?: string[];
}): string | undefined {
  const explicit = params.explicitActor?.trim();
  if (explicit) {
    return explicit;
  }
  const fromContext = params.ctxAgentId?.trim();
  if (fromContext) {
    return fromContext;
  }
  const fallback = params.fallbackAgents?.find((item) => item.trim());
  return fallback?.trim();
}

function fallbackAgentsForRole(config: ReturnType<typeof resolveWorkflowConfig>, role: WorkflowRole): string[] {
  switch (role) {
    case "planner":
      return config.roles.planner;
    case "reviewer":
      return config.roles.reviewer;
    case "patrol":
      return config.roles.patrol;
    case "executor":
    default:
      return [];
  }
}

function roleLabel(role: WorkflowRole): string {
  switch (role) {
    case "planner":
      return "planner";
    case "reviewer":
      return "reviewer";
    case "patrol":
      return "patrol";
    case "executor":
    default:
      return "executor";
  }
}

function requireRoleAgent(params: {
  role: WorkflowRole;
  ctxAgentId?: string;
  explicitActor?: string;
  config: ReturnType<typeof resolveWorkflowConfig>;
}): { ok: true; agentId: string } | { ok: false; text: string } {
  const fallbackAgents = fallbackAgentsForRole(params.config, params.role);
  const agentId = resolveActingAgent({
    ctxAgentId: params.ctxAgentId,
    explicitActor: params.explicitActor,
    fallbackAgents,
  });
  if (!agentId) {
    return {
      ok: false,
      text:
        `找不到 ${roleLabel(params.role)} agent。\n` +
        `先在当前线程执行 \`/focus <${roleLabel(params.role)}-agent>\`，或者给命令补 \`--actor <agentId>\`。`,
    };
  }
  const role = inferWorkflowRole(agentId, params.config);
  if (role !== params.role) {
    return {
      ok: false,
      text:
        `agent \`${agentId}\` 不是 ${roleLabel(params.role)}。\n` +
        `可用 ${roleLabel(params.role)}: ${formatAgents(fallbackAgents)}\n` +
        `先 \`/focus <${roleLabel(params.role)}-agent>\`，或者改用 \`--actor <${roleLabel(params.role)}-agent>\`。`,
    };
  }
  return { ok: true, agentId };
}

function buildCreateTaskUsage(): string {
  return [
    "Usage: /workflow create-task \"任务名\" [--description \"描述\"] [--actor <agentId>]",
    "示例：",
    "- /workflow create-task \"接入 Discord workflow 入口\" --description \"先打通 planner 到 reviewer 闭环\"",
    "- /workflow create-task \"修复高风险迁移流程\" --actor main",
  ].join("\n");
}

function buildPlanSubtasksUsage(): string {
  return [
    "Usage: /workflow plan-subtasks <taskId> [--plan \"草案\"] [--assigned <agentId>] [--persist] [--actor <agentId>]",
    "说明：",
    "- `--plan` 可用分号 `;` 分隔多个条目，也可直接贴多行 bullet",
    "- 不带 `--persist` 时只预览 draft，不落库",
    "- 默认使用当前线程绑定的 planner agent；未绑定时可补 `--actor <agentId>`",
    "示例：",
    "- /workflow plan-subtasks <taskId> --persist",
    "- /workflow plan-subtasks <taskId> --plan \"梳理路由 | owner: dev1 ; 补测试 | owner: qa\" --persist",
  ].join("\n");
}

function buildCancelSubtaskUsage(): string {
  return [
    "Usage: /workflow cancel-subtask <subtaskId> [--summary \"原因\"] [--actor <agentId>]",
    "示例：",
    "- /workflow cancel-subtask <subtaskId> --summary \"scope changed\"",
  ].join("\n");
}

function buildCreateSubtaskUsage(): string {
  return [
    "Usage: /workflow create-subtask <taskId> \"子任务名\" [--assigned <agentId>] [--priority low|medium|high] [--description \"...\"] [--deliverable \"...\"] [--acceptance \"...\"] [--high-risk] [--risk-tags \"a,b\"] [--actor <agentId>]",
    "示例：",
    "- /workflow create-subtask <taskId> \"接 Discord slash command\" --assigned dev1 --priority high",
    "- /workflow create-subtask <taskId> \"补 reviewer 验证\" --description \"补测试和回归检查\" --actor main",
  ].join("\n");
}

function buildReviewSubtaskUsage(): string {
  return [
    "Usage: /workflow review-subtask <subtaskId> --result approved|rejected --score <1-5> [--issues \"...\"] [--comment \"...\"] [--reassign <agentId>] [--actor <agentId>]",
    "示例：",
    "- /workflow review-subtask <subtaskId> --result approved --score 5 --comment \"OK to merge\"",
    "- /workflow review-subtask <subtaskId> --result rejected --score 2 --issues \"missing tests\" --reassign dev1",
  ].join("\n");
}

function buildBlockSubtaskUsage(): string {
  return [
    "Usage: /workflow block-subtask <subtaskId> [--summary \"原因\"] [--actor <agentId>]",
    "示例：",
    "- /workflow block-subtask <subtaskId> --summary \"waiting on API token\"",
  ].join("\n");
}

function buildUnblockSubtaskUsage(): string {
  return [
    "Usage: /workflow unblock-subtask <subtaskId> --resolution \"处理结果\" [--assigned <agentId>] [--actor <agentId>]",
    "示例：",
    "- /workflow unblock-subtask <subtaskId> --resolution \"dependency fixed\" --assigned dev1",
  ].join("\n");
}

function buildClaimSubtaskUsage(): string {
  return [
    "Usage: /workflow claim-subtask <subtaskId> [--actor <agentId>]",
    "说明：",
    "- executor 通常直接用当前线程绑定的 agent，不建议跨线程代领",
    "示例：",
    "- /workflow claim-subtask <subtaskId>",
  ].join("\n");
}

function buildStartSubtaskUsage(): string {
  return [
    "Usage: /workflow start-subtask <subtaskId> [--actor <agentId>]",
    "示例：",
    "- /workflow start-subtask <subtaskId>",
  ].join("\n");
}

function buildSubmitSubtaskUsage(): string {
  return [
    "Usage: /workflow submit-subtask <subtaskId> [--commit <sha>] [--change \"...\"] --test \"...\" --delivery \"...\" [--risk-summary \"...\"] [--base-ref <ref>] [--branch-ref <ref>] [--high-risk] [--risk-tags \"a,b\"] [--actor <agentId>]",
    "必填规则：",
    "- `--test` 必填",
    "- `--delivery` 必填",
    "- `--commit` 和 `--change` 至少要有一个",
    "示例：",
    "- /workflow submit-subtask <subtaskId> --commit abc1234 --test \"vitest passed\" --delivery \"ready for QA\"",
  ].join("\n");
}

function buildHandoffSubtaskUsage(): string {
  return [
    "Usage: /workflow handoff-subtask <subtaskId> --handoff \"交接说明\" [--commit <sha>] [--test \"...\"] [--risk-summary \"...\"] [--base-ref <ref>] [--branch-ref <ref>] [--high-risk] [--risk-tags \"a,b\"] [--actor <agentId>]",
    "示例：",
    "- /workflow handoff-subtask <subtaskId> --handoff \"state captured before review\" --commit abc1234",
  ].join("\n");
}

function buildCreateTaskResult(params: {
  id: string;
  name: string;
  actorAgentId: string;
  baseUrl: string;
}): string {
  return [
    "任务已创建",
    `- taskId: ${params.id}`,
    `- name: ${params.name}`,
    `- actor: ${params.actorAgentId}`,
    "",
    `面板：${params.baseUrl}`,
    `下一步：/workflow plan-subtasks ${params.id} --persist`,
  ].join("\n");
}

function buildPlanSubtasksResult(params: {
  taskId: string;
  persisted: boolean;
  draftLines: string[];
  createdIds: string[];
  baseUrl: string;
}): string {
  return [
    params.persisted ? "子任务已生成并落库" : "子任务 draft 预览",
    `- taskId: ${params.taskId}`,
    `- drafts: ${params.draftLines.length}`,
    ...(params.persisted ? [`- created: ${params.createdIds.join(", ") || "0"}`] : []),
    "",
    ...params.draftLines,
    "",
    params.persisted
      ? `面板：${params.baseUrl}`
      : `如要落库，执行：/workflow plan-subtasks ${params.taskId} --persist`,
  ].join("\n");
}

function buildCancelSubtaskResult(params: {
  subtaskId: string;
  name: string;
  actorAgentId: string;
  baseUrl: string;
}): string {
  return [
    "子任务已取消",
    `- subtaskId: ${params.subtaskId}`,
    `- name: ${params.name}`,
    `- actor: ${params.actorAgentId}`,
    "",
    `面板：${params.baseUrl}`,
  ].join("\n");
}

function buildCreateSubtaskResult(params: {
  id: string;
  name: string;
  actorAgentId: string;
  assignedAgentId?: string | null;
  status: string;
  baseUrl: string;
}): string {
  return [
    "子任务已创建",
    `- subtaskId: ${params.id}`,
    `- name: ${params.name}`,
    `- actor: ${params.actorAgentId}`,
    `- owner: ${params.assignedAgentId ?? "unassigned"}`,
    `- status: ${params.status}`,
    "",
    `面板：${params.baseUrl}`,
  ].join("\n");
}

function buildReviewSubtaskResult(params: {
  subtaskId: string;
  result: string;
  score: number;
  status: string;
  actorAgentId: string;
  baseUrl: string;
}): string {
  return [
    "评审已记录",
    `- subtaskId: ${params.subtaskId}`,
    `- result: ${params.result}`,
    `- score: ${params.score}/5`,
    `- status: ${params.status}`,
    `- reviewer: ${params.actorAgentId}`,
    "",
    `面板：${params.baseUrl}`,
  ].join("\n");
}

function buildBlockSubtaskResult(params: {
  subtaskId: string;
  name: string;
  actorAgentId: string;
  status: string;
  baseUrl: string;
}): string {
  return [
    "子任务已阻塞",
    `- subtaskId: ${params.subtaskId}`,
    `- name: ${params.name}`,
    `- actor: ${params.actorAgentId}`,
    `- status: ${params.status}`,
    "",
    `面板：${buildWorkflowUrl(params.baseUrl, { subtaskStatus: "blocked" })}`,
  ].join("\n");
}

function buildUnblockSubtaskResult(params: {
  subtaskId: string;
  name: string;
  actorAgentId: string;
  status: string;
  assignedAgentId?: string | null;
  baseUrl: string;
}): string {
  return [
    "子任务已解除阻塞",
    `- subtaskId: ${params.subtaskId}`,
    `- name: ${params.name}`,
    `- actor: ${params.actorAgentId}`,
    `- status: ${params.status}`,
    `- owner: ${params.assignedAgentId ?? "unassigned"}`,
    "",
    `面板：${params.baseUrl}`,
  ].join("\n");
}

function parseScore(raw: string | undefined): number | null {
  if (!raw?.trim()) {
    return null;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildExecutorMutationResult(params: {
  title: string;
  subtaskId: string;
  name: string;
  actorAgentId: string;
  status: string;
  baseUrl: string;
  extraLines?: string[];
}): string {
  return [
    params.title,
    `- subtaskId: ${params.subtaskId}`,
    `- name: ${params.name}`,
    `- actor: ${params.actorAgentId}`,
    `- status: ${params.status}`,
    ...(params.extraLines ?? []),
    "",
    `面板：${params.baseUrl}`,
  ].join("\n");
}

export function createWorkflowCommand(params: {
  api: OpenClawPluginApi;
}): OpenClawPluginCommandDefinition {
  return {
    name: "workflow",
    description: "Workflow 治理入口：看板、角色流程和治理视图。",
    acceptsArgs: true,
    handler: async (ctx) => {
      const rawArgs = ctx.args?.trim() ?? "";
      const parsed = parseCommandArgs(rawArgs);
      const action = parsed.action.toLowerCase();
      const config = resolveWorkflowConfig(params.api.pluginConfig);
      const baseUrl = resolveWorkflowDashboardBaseUrl(params.api);
      const store = getWorkflowStore(params.api.pluginConfig, params.api.logger);

      if (action === "dashboard") {
        return {
          text: [
            "Workflow 面板入口",
            `- 总览：${baseUrl}`,
            `- 评审：${buildWorkflowUrl(baseUrl, { observationRole: "reviewer" })}`,
            `- 阻塞：${buildWorkflowUrl(baseUrl, { subtaskStatus: "blocked" })}`,
            `- 高风险：${buildWorkflowUrl(baseUrl, {
              highRisk: true,
              observationHighRisk: true,
            })}`,
            "",
            "提示：这里只返回不带 token 的本地链接，避免把网关凭证发到聊天里。",
          ].join("\n"),
        };
      }

      if (action === "planner") {
        return {
          text: buildPlannerText({
            baseUrl,
            plannerAgents: config.roles.planner,
          }),
        };
      }

      if (action === "executor") {
        return {
          text: buildExecutorText({ baseUrl }),
        };
      }

      if (action === "reviewer") {
        return {
          text: buildReviewerText({
            baseUrl,
            reviewerAgents: config.roles.reviewer,
          }),
        };
      }

      if (action === "ops" || action === "patrol") {
        return {
          text: buildOpsText({
            baseUrl,
            patrolAgents: config.roles.patrol,
          }),
        };
      }

      if (action === "queue" || action === "summary") {
        return { text: buildQueueText(params.api, baseUrl) };
      }

      if (action === "review") {
        return { text: buildReviewQueueText(params.api, baseUrl) };
      }

      if (action === "blocked") {
        return { text: buildBlockedText(params.api, baseUrl) };
      }

      if (action === "high-risk" || action === "highrisk" || action === "risk") {
        return { text: buildHighRiskText(params.api, baseUrl) };
      }

      if (action === "create-task") {
        const planner = requireRoleAgent({
          role: "planner",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!planner.ok) {
          return { text: planner.text };
        }
        const name = parsed.positionals.join(" ").trim();
        if (!name) {
          return { text: buildCreateTaskUsage() };
        }
        const created = store.createTask({
          name,
          description: flagString(parsed.flags, "description", "desc"),
          actor: {
            agentId: planner.agentId,
            sessionKey: ctx.sessionKey,
          },
        });
        return {
          text: buildCreateTaskResult({
            id: created.id,
            name: created.name,
            actorAgentId: planner.agentId,
            baseUrl,
          }),
        };
      }

      if (action === "create-subtask") {
        const planner = requireRoleAgent({
          role: "planner",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!planner.ok) {
          return { text: planner.text };
        }
        const taskId = parsed.positionals[0]?.trim();
        const name = parsed.positionals.slice(1).join(" ").trim();
        if (!taskId || !name) {
          return { text: buildCreateSubtaskUsage() };
        }
        try {
          const created = store.createSubtask({
            taskId,
            name,
            description: flagString(parsed.flags, "description", "desc"),
            deliverable: flagString(parsed.flags, "deliverable"),
            acceptance: flagString(parsed.flags, "acceptance"),
            priority: flagString(parsed.flags, "priority"),
            assignedAgentId: flagString(
              parsed.flags,
              "assigned",
              "assigned-agent",
              "assigned-agent-id",
            ),
            isHighRisk: flagBoolean(parsed.flags, "high-risk", "highrisk"),
            riskTags: flagString(parsed.flags, "risk-tags", "risktags", "risk"),
            actor: {
              agentId: planner.agentId,
              sessionKey: ctx.sessionKey,
            },
          });
          return {
            text: buildCreateSubtaskResult({
              id: created.id,
              name: created.name,
              actorAgentId: planner.agentId,
              assignedAgentId: created.assigned_agent_id,
              status: created.status,
              baseUrl,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `创建失败：${message}` };
        }
      }

      if (action === "plan-subtasks") {
        const planner = requireRoleAgent({
          role: "planner",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!planner.ok) {
          return { text: planner.text };
        }
        const taskId = parsed.positionals[0]?.trim();
        if (!taskId) {
          return { text: buildPlanSubtasksUsage() };
        }
        const task = store.getTask(taskId);
        if (!task) {
          return { text: `找不到 task: ${taskId}` };
        }
        const planned = getWorkflowStore(params.api.pluginConfig, params.api.logger);
        const result = (() => {
          const generated = normalizePlannerSource(flagString(parsed.flags, "plan"));
          const preview = planSubtasksForTask({
            task,
            source: generated,
            defaultAssignedAgentId: flagString(
              parsed.flags,
              "assigned",
              "assigned-agent",
              "assigned-agent-id",
            ),
            existingSubtasks: planned.listSubtasks({ taskId }),
          });
          const persist = flagBoolean(parsed.flags, "persist") ?? false;
          const created = persist
            ? preview.map((draft) =>
                planned.createSubtask({
                  taskId,
                  name: draft.name,
                  description: draft.description,
                  deliverable: draft.deliverable,
                  acceptance: draft.acceptance,
                  priority: draft.priority,
                  isHighRisk: draft.isHighRisk,
                  riskTags: draft.riskTags,
                  assignedAgentId: draft.assignedAgentId,
                  actor: {
                    agentId: planner.agentId,
                    sessionKey: ctx.sessionKey,
                  },
                }),
              )
            : [];
          return { preview, persist, created };
        })();
        return {
          text: buildPlanSubtasksResult({
            taskId,
            persisted: result.persist,
            draftLines: result.preview.map(
              (draft, index) =>
                `- ${index + 1}. ${draft.name} | priority=${draft.priority} | owner=${draft.assignedAgentId ?? "unassigned"}${draft.isHighRisk ? " | high-risk" : ""}`,
            ),
            createdIds: result.created.map((item) => item.id),
            baseUrl,
          }),
        };
      }

      if (action === "cancel-subtask") {
        const planner = requireRoleAgent({
          role: "planner",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!planner.ok) {
          return { text: planner.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        if (!subtaskId) {
          return { text: buildCancelSubtaskUsage() };
        }
        try {
          const cancelled = store.cancelSubtask({
            subtaskId,
            agentId: planner.agentId,
            summary: flagString(parsed.flags, "summary"),
          });
          return {
            text: buildCancelSubtaskResult({
              subtaskId: cancelled.id,
              name: cancelled.name,
              actorAgentId: planner.agentId,
              baseUrl,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `取消失败：${message}` };
        }
      }

      if (action === "review-subtask" || action === "approve" || action === "reject") {
        const reviewer = requireRoleAgent({
          role: "reviewer",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!reviewer.ok) {
          return { text: reviewer.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        const result =
          action === "approve"
            ? "approved"
            : action === "reject"
              ? "rejected"
              : flagString(parsed.flags, "result")?.toLowerCase();
        const score = parseScore(flagString(parsed.flags, "score"));
        if (!subtaskId || !result || score === null) {
          return { text: buildReviewSubtaskUsage() };
        }
        if (result !== "approved" && result !== "rejected") {
          return { text: "review result 只能是 approved 或 rejected。" };
        }
        try {
          const reviewed = store.reviewSubtask({
            subtaskId,
            reviewerAgentId: reviewer.agentId,
            result,
            score,
            issues: flagString(parsed.flags, "issues"),
            comment: flagString(parsed.flags, "comment"),
            reworkAgentId: flagString(parsed.flags, "reassign", "assigned"),
          });
          return {
            text: buildReviewSubtaskResult({
              subtaskId: reviewed.subtask.id,
              result,
              score,
              status: reviewed.subtask.status,
              actorAgentId: reviewer.agentId,
              baseUrl,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `评审失败：${message}` };
        }
      }

      if (action === "block-subtask") {
        const patrol = requireRoleAgent({
          role: "patrol",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!patrol.ok) {
          return { text: patrol.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        if (!subtaskId) {
          return { text: buildBlockSubtaskUsage() };
        }
        try {
          const blocked = store.blockSubtask({
            subtaskId,
            agentId: patrol.agentId,
            summary: flagString(parsed.flags, "summary"),
          });
          return {
            text: buildBlockSubtaskResult({
              subtaskId: blocked.id,
              name: blocked.name,
              actorAgentId: patrol.agentId,
              status: blocked.status,
              baseUrl,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `阻塞失败：${message}` };
        }
      }

      if (action === "unblock-subtask") {
        const patrol = requireRoleAgent({
          role: "patrol",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!patrol.ok) {
          return { text: patrol.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        const resolution = flagString(parsed.flags, "resolution", "summary");
        if (!subtaskId || !resolution) {
          return { text: buildUnblockSubtaskUsage() };
        }
        try {
          const unblocked = store.unblockSubtask({
            subtaskId,
            agentId: patrol.agentId,
            resolution,
            assignedAgentId: flagString(
              parsed.flags,
              "assigned",
              "assigned-agent",
              "assigned-agent-id",
            ),
          });
          return {
            text: buildUnblockSubtaskResult({
              subtaskId: unblocked.id,
              name: unblocked.name,
              actorAgentId: patrol.agentId,
              status: unblocked.status,
              assignedAgentId: unblocked.assigned_agent_id,
              baseUrl,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `解除阻塞失败：${message}` };
        }
      }

      if (action === "claim-subtask") {
        const executor = requireRoleAgent({
          role: "executor",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!executor.ok) {
          return { text: executor.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        if (!subtaskId) {
          return { text: buildClaimSubtaskUsage() };
        }
        try {
          const claimed = store.claimSubtask({
            subtaskId,
            agentId: executor.agentId,
            sessionKey: ctx.sessionKey,
          });
          return {
            text: buildExecutorMutationResult({
              title: "子任务已认领",
              subtaskId: claimed.id,
              name: claimed.name,
              actorAgentId: executor.agentId,
              status: claimed.status,
              baseUrl,
              extraLines: [`- owner: ${claimed.assigned_agent_id ?? "unassigned"}`],
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `认领失败：${message}` };
        }
      }

      if (action === "start-subtask") {
        const executor = requireRoleAgent({
          role: "executor",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!executor.ok) {
          return { text: executor.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        if (!subtaskId) {
          return { text: buildStartSubtaskUsage() };
        }
        try {
          const started = store.startSubtask({
            subtaskId,
            agentId: executor.agentId,
            sessionKey: ctx.sessionKey,
          });
          return {
            text: buildExecutorMutationResult({
              title: "子任务已开始执行",
              subtaskId: started.id,
              name: started.name,
              actorAgentId: executor.agentId,
              status: started.status,
              baseUrl,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `开始失败：${message}` };
        }
      }

      if (action === "submit-subtask") {
        const executor = requireRoleAgent({
          role: "executor",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!executor.ok) {
          return { text: executor.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        if (!subtaskId) {
          return { text: buildSubmitSubtaskUsage() };
        }
        try {
          const submitted = store.submitSubtask({
            subtaskId,
            agentId: executor.agentId,
            commitRef: flagString(parsed.flags, "commit", "commit-ref"),
            changeSummary: flagString(parsed.flags, "change", "change-summary"),
            testSummary: flagString(parsed.flags, "test", "test-summary"),
            deliverySummary: flagString(parsed.flags, "delivery", "delivery-summary"),
            riskSummary: flagString(parsed.flags, "risk-summary"),
            isHighRisk: flagBoolean(parsed.flags, "high-risk", "highrisk"),
            riskTags: flagString(parsed.flags, "risk-tags", "risktags", "risk"),
            baseRef: flagString(parsed.flags, "base-ref"),
            branchRef: flagString(parsed.flags, "branch-ref"),
          });
          return {
            text: buildExecutorMutationResult({
              title: "子任务已提交评审",
              subtaskId: submitted.id,
              name: submitted.name,
              actorAgentId: executor.agentId,
              status: submitted.status,
              baseUrl,
              extraLines: [
                `- commit: ${submitted.latest_commit_ref || "(none)"}`,
                `- review: ${buildWorkflowUrl(baseUrl, { observationRole: "reviewer" })}`,
              ],
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `提交失败：${message}` };
        }
      }

      if (action === "handoff-subtask") {
        const executor = requireRoleAgent({
          role: "executor",
          ctxAgentId: ctx.agentId,
          explicitActor: flagString(parsed.flags, "actor"),
          config,
        });
        if (!executor.ok) {
          return { text: executor.text };
        }
        const subtaskId = parsed.positionals[0]?.trim();
        const handoffSummary = flagString(parsed.flags, "handoff", "handoff-summary");
        if (!subtaskId || !handoffSummary) {
          return { text: buildHandoffSubtaskUsage() };
        }
        try {
          const handedOff = store.handoffSubtask({
            subtaskId,
            agentId: executor.agentId,
            baseRef: flagString(parsed.flags, "base-ref"),
            branchRef: flagString(parsed.flags, "branch-ref"),
            commitRef: flagString(parsed.flags, "commit", "commit-ref"),
            testSummary: flagString(parsed.flags, "test", "test-summary"),
            handoffSummary,
            riskSummary: flagString(parsed.flags, "risk-summary"),
            isHighRisk: flagBoolean(parsed.flags, "high-risk", "highrisk"),
            riskTags: flagString(parsed.flags, "risk-tags", "risktags", "risk"),
          });
          return {
            text: buildExecutorMutationResult({
              title: "交接信息已记录",
              subtaskId: handedOff.id,
              name: handedOff.name,
              actorAgentId: executor.agentId,
              status: handedOff.status,
              baseUrl,
              extraLines: [`- handoff: ${handedOff.handoff_summary || "(none)"}`],
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { text: `交接失败：${message}` };
        }
      }

      return {
        text: buildOverviewText({
          api: params.api,
          baseUrl,
          plannerAgents: config.roles.planner,
          reviewerAgents: config.roles.reviewer,
          patrolAgents: config.roles.patrol,
          inDiscordThread: ctx.channel === "discord" && ctx.messageThreadId !== undefined,
        }),
      };
    },
  };
}
