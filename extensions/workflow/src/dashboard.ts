import { roleSummary } from "./config.js";
import type {
  ActivityLogRecord,
  GovernanceMetrics,
  ReviewRecord,
  StageGateSummary,
  SubtaskRecord,
  TaskRecord,
} from "./schema.js";

export function renderWorkflowDashboard(params: {
  basePath: string;
  configInput: unknown;
  filters: {
    taskStatus?: string;
    subtaskStatus?: string;
    currentRole?: string;
    highRisk?: boolean;
    observationRole?: string;
    observationHighRisk?: boolean;
    activityAction?: string;
  };
  summary: {
    tasks: Record<string, number>;
    subtasks: Record<string, number>;
    stale: Record<string, number>;
  };
  metrics: GovernanceMetrics;
  stageGates: StageGateSummary;
  tasks: TaskRecord[];
  subtasks: SubtaskRecord[];
  observations: SubtaskRecord[];
  reviews: ReviewRecord[];
  activity: ActivityLogRecord[];
}): string {
  const bindings = localizeRoleBindings(
    roleSummary(params.configInput) || "planner/reviewer/patrol not configured",
  );
  const qaObservations = params.observations.filter(
    (item) => item.status === "review" || item.status === "rework",
  );
  const opsObservations = params.observations.filter(
    (item) =>
      item.status === "blocked" || item.status === "assigned" || item.status === "in_progress",
  );
  const highRiskObservations = params.observations.filter((item) => item.is_high_risk);
  const dashboardFilters = params.filters;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>工作流看板</title>
    <style>
      :root {
        --bg: #f4efe4;
        --panel: rgba(255, 251, 243, 0.88);
        --panel-strong: #fffaf0;
        --ink: #1c2430;
        --muted: #5e6a78;
        --accent: #0f766e;
        --accent-2: #ba4a00;
        --line: rgba(28, 36, 48, 0.14);
        --shadow: 0 20px 60px rgba(28, 36, 48, 0.12);
        --radius: 22px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.18), transparent 26rem),
          radial-gradient(circle at top right, rgba(186, 74, 0, 0.14), transparent 24rem),
          linear-gradient(180deg, #f7f2e8 0%, var(--bg) 100%);
        font-family: "PingFang SC", "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif;
      }

      a {
        color: var(--accent);
      }

      code,
      input,
      textarea,
      select,
      button,
      table {
        font-family: "SFMono-Regular", "JetBrains Mono", "Cascadia Mono", "PingFang SC", monospace;
      }

      .page {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      .hero {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 18px;
        align-items: stretch;
        margin-bottom: 20px;
      }

      .hero-card,
      .panel {
        background: var(--panel);
        backdrop-filter: blur(16px);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }

      .hero-card {
        padding: 28px;
      }

      .eyebrow {
        margin: 0 0 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--accent);
        font-size: 12px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(2rem, 3.8vw, 3.6rem);
        line-height: 0.96;
      }

      .hero p,
      .meta {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid var(--line);
        color: var(--ink);
        font-size: 13px;
      }

      .summary-grid,
      .content-grid {
        display: grid;
        gap: 18px;
      }

      .summary-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin-bottom: 18px;
      }

      .content-grid {
        grid-template-columns: 1.35fr 1fr;
      }

      .panel {
        padding: 20px;
      }

      .panel h2 {
        margin: 0 0 6px;
        font-size: 1.1rem;
      }

      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 14px;
      }

      .panel-head p {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }

      .stat {
        display: grid;
        gap: 8px;
        align-content: start;
        min-height: 120px;
      }

      .stat strong {
        font-size: clamp(2rem, 3.4vw, 3rem);
        line-height: 0.95;
      }

      .stat-label {
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .stat-breakdown {
        color: var(--muted);
        line-height: 1.45;
        font-size: 13px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      th,
      td {
        text-align: left;
        padding: 10px 0;
        vertical-align: top;
        border-bottom: 1px solid var(--line);
      }

      th {
        color: var(--muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
      }

      tr:last-child td {
        border-bottom: 0;
      }

      .status {
        display: inline-flex;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.12);
        color: var(--accent);
        font-size: 11px;
      }

      .status.status-review,
      .status.status-blocked,
      .status.status-cancelled {
        background: rgba(186, 74, 0, 0.12);
        color: var(--accent-2);
      }

      .risk-flag {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(186, 74, 0, 0.16);
        color: var(--accent-2);
        font-size: 11px;
      }

      .forms {
        display: grid;
        gap: 14px;
      }

      form {
        display: grid;
        gap: 10px;
        padding: 14px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid var(--line);
      }

      form h3 {
        margin: 0;
        font-size: 15px;
      }

      .form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
      }

      input,
      textarea,
      select,
      button {
        width: 100%;
        border: 1px solid rgba(28, 36, 48, 0.18);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13px;
        color: var(--ink);
        background: #fffdf8;
      }

      textarea {
        min-height: 86px;
        resize: vertical;
      }

      button {
        cursor: pointer;
        background: var(--ink);
        color: #fff;
        border: 0;
      }

      .actions {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }

      .quiet {
        font-size: 12px;
        color: var(--muted);
      }

      .quiet strong {
        color: var(--ink);
      }

      .empty {
        color: var(--muted);
        font-style: italic;
      }

      .hint {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .result {
        margin: 0;
        padding: 12px;
        border-radius: 14px;
        background: rgba(28, 36, 48, 0.04);
        border: 1px solid var(--line);
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        min-height: 72px;
      }

      .filter-bar {
        display: grid;
        gap: 10px;
        margin-bottom: 18px;
      }

      .filter-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      @media (max-width: 960px) {
        .hero,
        .content-grid,
        .summary-grid,
        .form-grid {
          grid-template-columns: 1fr;
        }

        .page {
          width: min(100vw - 20px, 1200px);
          padding-top: 20px;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <article class="hero-card">
          <p class="eyebrow">OpenClaw 工作流</p>
          <h1>规划、执行、评审、巡检。</h1>
          <p>这是 OpenClaw 的工作流 MVP 看板。它先把任务队列可视化，不把编排逻辑硬塞进 core。</p>
          <div class="chips">
            <span class="chip">角色绑定：${escapeHtml(bindings)}</span>
            <span class="chip">JSON 接口：<a href="${params.basePath}/queue-summary">queue-summary</a></span>
            <span class="chip">根路径：<a href="${params.basePath}/">${params.basePath}/</a></span>
          </div>
        </article>
        <article class="hero-card">
          <div class="meta">
            <span>任务：${params.summary.tasks.total}</span>
            <span>子任务：${params.summary.subtasks.total}</span>
            <span>评审：${params.reviews.length}</span>
            <span>活动：${params.activity.length}</span>
          </div>
          <div class="chips">
            <span class="chip">已分配超时：${renderInlineLink("查看", buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "assigned", currentRole: "executor" }, "subtasks-panel"))} ${params.summary.stale.assigned}</span>
            <span class="chip">进行中超时：${renderInlineLink("查看", buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "in_progress", currentRole: "executor" }, "subtasks-panel"))} ${params.summary.stale.in_progress}</span>
            <span class="chip">待评审：${renderInlineLink("查看", buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "review", currentRole: "reviewer", observationRole: "reviewer" }, "qa-panel"))} ${params.metrics.review_pending}</span>
            <span class="chip">阻塞：${renderInlineLink("查看", buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "blocked", observationRole: "patrol" }, "ops-panel"))} ${params.metrics.blocked}</span>
            <span class="chip">高风险开放：${renderInlineLink("查看", buildDashboardHref(params.basePath, dashboardFilters, { highRisk: true, observationHighRisk: true }, "high-risk-panel"))} ${params.metrics.high_risk_open}</span>
            <span class="chip">7 日接管：${renderInlineLink("查看", buildDashboardHref(params.basePath, dashboardFilters, { activityAction: "manual_takeover" }, "activity-panel"))} ${params.metrics.manual_takeovers_7d}</span>
          </div>
          <p class="quiet" style="margin-top: 16px;">浏览器访问返回 HTML，看板以外的程序仍然可以继续使用同前缀下的 JSON 路由。</p>
        </article>
      </section>

      <section class="summary-grid">
        ${renderStatCard("任务队列", params.summary.tasks.total, [
          { text: `规划中 ${params.summary.tasks.planning}`, href: buildDashboardHref(params.basePath, dashboardFilters, { taskStatus: "planning" }, "tasks-panel") },
          { text: `进行中 ${params.summary.tasks.active}`, href: buildDashboardHref(params.basePath, dashboardFilters, { taskStatus: "active" }, "tasks-panel") },
          { text: `已完成 ${params.summary.tasks.completed}`, href: buildDashboardHref(params.basePath, dashboardFilters, { taskStatus: "completed" }, "tasks-panel") },
          { text: `已取消 ${params.summary.tasks.cancelled}`, href: buildDashboardHref(params.basePath, dashboardFilters, { taskStatus: "cancelled" }, "tasks-panel") },
        ])}
        ${renderStatCard("执行队列", params.summary.subtasks.total, [
          { text: `待领取 ${params.summary.subtasks.pending}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "pending" }, "subtasks-panel") },
          { text: `已分配 ${params.summary.subtasks.assigned}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "assigned", currentRole: "executor" }, "subtasks-panel") },
          { text: `执行中 ${params.summary.subtasks.in_progress}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "in_progress", currentRole: "executor" }, "subtasks-panel") },
          { text: `返工中 ${params.summary.subtasks.rework}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "rework", currentRole: "executor" }, "qa-panel") },
        ])}
        ${renderStatCard("评审压力", params.summary.subtasks.review, [
          { text: `阻塞 ${params.summary.subtasks.blocked}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "blocked", observationRole: "patrol" }, "ops-panel") },
          { text: `完成 ${params.summary.subtasks.done}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "done" }, "subtasks-panel") },
          { text: `取消 ${params.summary.subtasks.cancelled}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "cancelled" }, "subtasks-panel") },
          { text: `高风险待评审 ${params.metrics.high_risk_review_pending}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "review", currentRole: "reviewer", highRisk: true, observationRole: "reviewer", observationHighRisk: true }, "high-risk-panel") },
        ])}
        ${renderStatCard("近期信号", params.activity.length, [
          { text: `高风险开放 ${params.metrics.high_risk_open}`, href: buildDashboardHref(params.basePath, dashboardFilters, { highRisk: true, observationHighRisk: true }, "high-risk-panel") },
          { text: `返工比例 ${formatMetricPercent(params.metrics.rework_rate)}` },
          { text: `线程重绑 ${params.metrics.thread_rebinds_7d}`, href: buildDashboardHref(params.basePath, dashboardFilters, { activityAction: "thread_rebound" }, "activity-panel") },
          { text: `平均评分 ${formatMetricNumber(params.metrics.avg_review_score)}` },
          { text: `驳回 ${params.metrics.rejected_reviews}/${params.metrics.total_reviews}` },
          { text: `平均等待 ${formatMetricMinutes(params.metrics.avg_review_wait_minutes)}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "review", currentRole: "reviewer", observationRole: "reviewer" }, "qa-panel") },
          { text: `最老待评审 ${formatMetricMinutes(params.metrics.oldest_review_age_minutes)}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "review", currentRole: "reviewer", observationRole: "reviewer" }, "qa-panel") },
          { text: `最老阻塞 ${formatMetricMinutes(params.metrics.oldest_blocked_age_minutes)}`, href: buildDashboardHref(params.basePath, dashboardFilters, { subtaskStatus: "blocked", observationRole: "patrol" }, "ops-panel") },
        ])}
      </section>

      <section class="panel filter-bar">
        <div class="panel-head">
          <div>
            <h2>筛选</h2>
            <p>筛选当前页面展示的任务、子任务和治理观察，URL 会同步更新。</p>
          </div>
          <a href="${params.basePath}/">重置</a>
        </div>
        <form id="workflow-filter-form" method="get" action="${params.basePath}/">
          <div class="filter-grid">
            <label>
              任务状态
              <select name="taskStatus">
                ${renderSelectOptions(
                  [
                    { value: "", label: "全部" },
                    { value: "planning", label: "规划中" },
                    { value: "active", label: "进行中" },
                    { value: "completed", label: "已完成" },
                    { value: "cancelled", label: "已取消" },
                  ],
                  params.filters.taskStatus,
                )}
              </select>
            </label>
            <label>
              子任务状态
              <select name="subtaskStatus">
                ${renderSelectOptions(
                  [
                    { value: "", label: "全部" },
                    { value: "pending", label: "待领取" },
                    { value: "assigned", label: "已分配" },
                    { value: "in_progress", label: "执行中" },
                    { value: "review", label: "待评审" },
                    { value: "rework", label: "返工中" },
                    { value: "blocked", label: "阻塞" },
                    { value: "done", label: "完成" },
                    { value: "cancelled", label: "已取消" },
                  ],
                  params.filters.subtaskStatus,
                )}
              </select>
            </label>
            <label>
              子任务角色
              <select name="currentRole">
                ${renderSelectOptions(
                  [
                    { value: "", label: "全部" },
                    { value: "planner", label: "规划" },
                    { value: "executor", label: "执行" },
                    { value: "reviewer", label: "评审" },
                    { value: "patrol", label: "巡检" },
                  ],
                  params.filters.currentRole,
                )}
              </select>
            </label>
            <label>
              子任务高风险
              <select name="highRisk">
                ${renderBooleanOptions(params.filters.highRisk)}
              </select>
            </label>
            <label>
              观察角色
              <select name="observationRole">
                ${renderSelectOptions(
                  [
                    { value: "", label: "全部" },
                    { value: "planner", label: "规划" },
                    { value: "executor", label: "执行" },
                    { value: "reviewer", label: "评审" },
                    { value: "patrol", label: "巡检" },
                  ],
                  params.filters.observationRole,
                )}
              </select>
            </label>
            <label>
              观察高风险
              <select name="observationHighRisk">
                ${renderBooleanOptions(params.filters.observationHighRisk)}
              </select>
            </label>
            <label>
              活动动作
              <select name="activityAction">
                ${renderSelectOptions(
                  [
                    { value: "", label: "全部" },
                    { value: "manual_takeover", label: "人工接管" },
                    { value: "thread_rebound", label: "线程重绑" },
                    { value: "review_timeout_takeover", label: "评审超时接管" },
                  ],
                  params.filters.activityAction,
                )}
              </select>
            </label>
          </div>
          <div class="actions">
            <button type="submit">应用筛选</button>
          </div>
        </form>
      </section>

      <section class="content-grid">
        <div class="panel-stack">
          <section class="panel" id="tasks-panel">
            <div class="panel-head">
              <div>
                <h2>任务</h2>
                <p>最近的任务列表，覆盖规划中、进行中、已完成和已取消状态。</p>
              </div>
              <a href="${params.basePath}/tasks">JSON</a>
            </div>
            ${renderTasksTable(params.tasks)}
          </section>

          <section class="panel" id="subtasks-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>子任务</h2>
                <p>最近的执行单元，包含分配人和状态可见性。</p>
              </div>
              <a href="${params.basePath}/subtasks">JSON</a>
            </div>
            ${renderSubtasksTable(params.subtasks)}
          </section>

          <section class="panel" id="observations-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>治理观察</h2>
                <p>评审、巡检和交接最关心的只读观察面。</p>
              </div>
              <a href="${params.basePath}/observations">JSON</a>
            </div>
            ${renderObservationTable(params.observations)}
          </section>

          <section class="panel" id="stage-gates-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>阶段门槛</h2>
                <p>把“建议指标”收口成当前可量化的治理门槛。</p>
              </div>
              <a href="${params.basePath}/stage-gates">JSON</a>
            </div>
            ${renderStageGates(params.basePath, dashboardFilters, params.stageGates)}
          </section>

          <section class="panel" id="qa-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>QA 观察</h2>
                <p>聚焦待评审与返工中的子任务。</p>
              </div>
            </div>
            ${renderObservationTable(qaObservations)}
          </section>

          <section class="panel" id="ops-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>Ops 观察</h2>
                <p>聚焦阻塞、执行中和需人工巡检的条目。</p>
              </div>
            </div>
            ${renderObservationTable(opsObservations)}
          </section>

          <section class="panel" id="high-risk-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>高风险观察</h2>
                <p>优先暴露高风险变更，方便 reviewer 和 planner 先看。</p>
              </div>
            </div>
            ${renderObservationTable(highRiskObservations)}
          </section>

          <section class="panel" id="activity-panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>活动</h2>
                <p>最近的工作流事件，覆盖规划、执行和评审。</p>
              </div>
              <a href="${params.basePath}/activity">JSON</a>
            </div>
            ${renderActivityTable(params.activity)}
          </section>
        </div>

        <div class="panel-stack">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>评审</h2>
                <p>最近的评审结果和评分快照。</p>
              </div>
              <a href="${params.basePath}/reviews">JSON</a>
            </div>
            ${renderReviewsTable(params.reviews)}
          </section>

          <section class="panel" style="margin-top: 18px;">
            <div class="panel-head">
              <div>
                <h2>快捷操作</h2>
                <p>基于现有 JSON 接口的轻量浏览器操作层。</p>
              </div>
              <span class="quiet" id="workflow-status">空闲</span>
            </div>
            <div class="forms">
              <form data-workflow-form method="post" action="${params.basePath}/tasks">
                <h3>创建任务</h3>
                <label>
                  名称
                  <input name="name" required />
                </label>
                <label>
                  描述
                  <textarea name="description"></textarea>
                </label>
                <label>
                  操作人 Agent ID
                  <input name="actor_agent_id" value="operator" />
                </label>
                <div class="actions">
                  <button type="submit">创建任务</button>
                </div>
              </form>

              <form
                data-workflow-form
                method="post"
                action=""
                data-action-template="${params.basePath}/tasks/{task_id}/plan-subtasks"
              >
                <h3>规划子任务</h3>
                <div class="form-grid">
                  <label>
                    任务 ID
                    <input name="task_id" required />
                  </label>
                  <label>
                    默认执行人 Agent ID
                    <input name="assigned_agent_id" />
                  </label>
                </div>
                <label>
                  规划人 Agent ID
                  <input name="actor_agent_id" value="pm" />
                </label>
                <label>
                  拆分草案
                  <textarea
                    name="plan"
                    placeholder="- 搭建看板骨架 | deliverable: HTML 页面 | acceptance: 根路由可渲染&#10;- 增加规划动作 | deliverable: plan_subtasks 流程 | acceptance: 可预览并可落库"
                  ></textarea>
                </label>
                <label>
                  是否立即落库
                  <select name="persist">
                    <option value="false" selected>仅预览</option>
                    <option value="true">立即创建子任务</option>
                  </select>
                </label>
                <p class="hint">建议先预览生成结果，确认无误后再切换到立即创建，把子任务落进队列。</p>
                <div class="actions">
                  <button type="submit">规划子任务</button>
                </div>
              </form>

              <form data-workflow-form method="post" action="${params.basePath}/subtasks">
                <h3>创建子任务</h3>
                <div class="form-grid">
                  <label>
                    任务 ID
                    <input name="task_id" required />
                  </label>
                  <label>
                    名称
                    <input name="name" required />
                  </label>
                </div>
                <label>
                  描述
                  <textarea name="description"></textarea>
                </label>
                <div class="form-grid">
                  <label>
                    交付物
                    <input name="deliverable" />
                  </label>
                  <label>
                    验收标准
                    <input name="acceptance" />
                  </label>
                </div>
                <div class="form-grid">
                  <label>
                    优先级
                    <select name="priority">
                      <option value="low">低</option>
                      <option value="medium" selected>中</option>
                      <option value="high">高</option>
                    </select>
                  </label>
                  <label>
                    执行人 Agent ID
                    <input name="assigned_agent_id" />
                  </label>
                </div>
                <div class="form-grid">
                  <label>
                    是否高风险
                    <select name="is_high_risk">
                      <option value="false" selected>否</option>
                      <option value="true">是</option>
                    </select>
                  </label>
                  <label>
                    风险标签
                    <input name="risk_tags" placeholder="schema, migration, auth" />
                  </label>
                </div>
                <label>
                  操作人 Agent ID
                  <input name="actor_agent_id" value="operator" />
                </label>
                <div class="actions">
                  <button type="submit">创建子任务</button>
                </div>
              </form>

              <form data-workflow-form method="post" action="" data-action-template="${params.basePath}/subtasks/{subtask_id}/submit">
                <h3>提交评审包</h3>
                <div class="form-grid">
                  <label>
                    子任务 ID
                    <input name="subtask_id" required />
                  </label>
                  <label>
                    执行人 Agent ID
                    <input name="actor_agent_id" value="dev1" />
                  </label>
                </div>
                <div class="form-grid">
                  <label>
                    Base
                    <input name="base_ref" placeholder="origin/main" />
                  </label>
                  <label>
                    分支
                    <input name="branch_ref" placeholder="workflow/subtask-dev1" />
                  </label>
                </div>
                <label>
                  提交引用
                  <input name="commit_ref" placeholder="abc1234" />
                </label>
                <label>
                  变更摘要
                  <textarea name="change_summary"></textarea>
                </label>
                <label>
                  测试摘要
                  <textarea name="test_summary"></textarea>
                </label>
                <label>
                  交付说明
                  <textarea name="delivery_summary"></textarea>
                </label>
                <label>
                  风险说明
                  <textarea name="risk_summary"></textarea>
                </label>
                <div class="form-grid">
                  <label>
                    是否高风险
                    <select name="is_high_risk">
                      <option value="false" selected>否</option>
                      <option value="true">是</option>
                    </select>
                  </label>
                  <label>
                    风险标签
                    <input name="risk_tags" placeholder="schema, migration, release" />
                  </label>
                </div>
                <div class="actions">
                  <button type="submit">提交评审包</button>
                </div>
              </form>

              <form data-workflow-form method="post" action="" data-action-template="${params.basePath}/subtasks/{subtask_id}/handoff">
                <h3>记录交接</h3>
                <div class="form-grid">
                  <label>
                    子任务 ID
                    <input name="subtask_id" required />
                  </label>
                  <label>
                    执行人 Agent ID
                    <input name="actor_agent_id" value="dev1" />
                  </label>
                </div>
                <div class="form-grid">
                  <label>
                    Base
                    <input name="base_ref" />
                  </label>
                  <label>
                    分支
                    <input name="branch_ref" />
                  </label>
                </div>
                <label>
                  提交引用
                  <input name="commit_ref" />
                </label>
                <label>
                  测试摘要
                  <textarea name="test_summary"></textarea>
                </label>
                <label>
                  交接说明
                  <textarea name="handoff_summary"></textarea>
                </label>
                <label>
                  风险说明
                  <textarea name="risk_summary"></textarea>
                </label>
                <div class="form-grid">
                  <label>
                    是否高风险
                    <select name="is_high_risk">
                      <option value="false" selected>否</option>
                      <option value="true">是</option>
                    </select>
                  </label>
                  <label>
                    风险标签
                    <input name="risk_tags" placeholder="session, handoff, infra" />
                  </label>
                </div>
                <div class="actions">
                  <button type="submit">记录交接</button>
                </div>
              </form>

              <form data-workflow-form method="post" action="" data-action-template="${params.basePath}/subtasks/{subtask_id}/unblock">
                <h3>解除阻塞</h3>
                <div class="form-grid">
                  <label>
                    子任务 ID
                    <input name="subtask_id" required />
                  </label>
                  <label>
                    操作人 Agent ID
                    <input name="actor_agent_id" value="ops" />
                  </label>
                </div>
                <label>
                  恢复后执行人 Agent ID
                  <input name="assigned_agent_id" />
                </label>
                <label>
                  恢复说明
                  <textarea name="resolution_summary"></textarea>
                </label>
                <div class="actions">
                  <button type="submit">解除阻塞</button>
                </div>
              </form>

              <form data-workflow-form method="post" action="" data-action-template="${params.basePath}/subtasks/{subtask_id}/cancel">
                <h3>取消子任务</h3>
                <div class="form-grid">
                  <label>
                    子任务 ID
                    <input name="subtask_id" required />
                  </label>
                  <label>
                    操作人 Agent ID
                    <input name="actor_agent_id" value="operator" />
                  </label>
                </div>
                <label>
                  原因说明
                  <input name="summary" />
                </label>
                <div class="actions">
                  <button type="submit">取消子任务</button>
                </div>
              </form>

              <form data-workflow-form method="post" action="${params.basePath}/activity">
                <h3>记录治理动作</h3>
                <div class="form-grid">
                  <label>
                    动作
                    <select name="action">
                      <option value="manual_takeover" selected>人工接管</option>
                      <option value="thread_rebound">线程重绑</option>
                      <option value="review_timeout_takeover">评审超时接管</option>
                    </select>
                  </label>
                  <label>
                    操作人 Agent ID
                    <input name="actor_agent_id" value="ops" />
                  </label>
                </div>
                <label>
                  子任务 ID
                  <input name="subtask_id" placeholder="可选，建议关联到具体 subtask" />
                </label>
                <label>
                  摘要
                  <textarea
                    name="summary"
                    placeholder="例如：qa 超时未响应，由 pm 临时接管 review；或 Discord 线程绑定失效，已人工重绑。"
                  ></textarea>
                </label>
                <p class="hint">这些动作会进入治理指标统计，并影响阶段门槛判断。</p>
                <div class="actions">
                  <button type="submit">记录治理动作</button>
                </div>
              </form>
            </div>
            <pre class="result" id="workflow-result">还没有提交任何操作。</pre>
          </section>
        </div>
      </section>
    </main>
    <script>
      const statusNode = document.getElementById("workflow-status");
      const resultNode = document.getElementById("workflow-result");

      for (const form of document.querySelectorAll("[data-workflow-form]")) {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const data = new FormData(form);
          const payload = {};
          for (const [key, value] of data.entries()) {
            if (typeof value === "string" && value.trim()) {
              payload[key] = value.trim();
            }
          }

          let action = form.getAttribute("action") || window.location.pathname;
          const actionTemplate = form.getAttribute("data-action-template");
          if (actionTemplate) {
            const taskId = payload.task_id;
            const subtaskId = payload.subtask_id;
            const routeId = taskId || subtaskId;
            if (!routeId) {
              statusNode.textContent = "缺少任务 ID 或子任务 ID";
              return;
            }
            action = actionTemplate
              .replace("{task_id}", encodeURIComponent(taskId || ""))
              .replace("{subtask_id}", encodeURIComponent(subtaskId || ""));
            delete payload.task_id;
            delete payload.subtask_id;
          }

          if (payload.persist === "true") {
            payload.persist = true;
          } else if (payload.persist === "false") {
            payload.persist = false;
          }

          statusNode.textContent = "提交中...";
          try {
            const res = await fetch(action, {
              method: "POST",
              headers: {
                "content-type": "application/json"
              },
              body: JSON.stringify(payload)
            });
            const body = await res.json();
            if (!res.ok || body.ok === false) {
              throw new Error(body.error || ("Request failed with status " + res.status));
            }
            resultNode.textContent = JSON.stringify(body.item || body, null, 2);
            if (body.item && Array.isArray(body.item.drafts)) {
              const persisted = body.item.persisted ? "已落库" : "仅预览";
              statusNode.textContent = "规划完成，状态：" + persisted + "，草案数：" + body.item.drafts.length;
              if (body.item.persisted) {
                window.location.reload();
              }
              return;
            }
            statusNode.textContent = "保存成功，正在刷新...";
            window.location.reload();
          } catch (error) {
            statusNode.textContent = "错误：" + String(error instanceof Error ? error.message : error);
          }
        });
      }
    </script>
  </body>
</html>`;
}

function renderStatCard(
  title: string,
  value: number,
  lines: Array<{ text: string; href?: string }>,
): string {
  return `<article class="panel stat">
    <span class="stat-label">${escapeHtml(title)}</span>
    <strong>${value}</strong>
    <div class="stat-breakdown">${lines.map((line) => renderLinkedText(line.text, line.href)).join("<br />")}</div>
  </article>`;
}

function renderTasksTable(items: TaskRecord[]): string {
  if (items.length === 0) {
    return `<p class="empty">还没有任务。</p>`;
  }
  return `<table>
    <thead>
      <tr><th>名称</th><th>状态</th><th>创建人</th><th>更新时间</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td><strong>${escapeHtml(item.name)}</strong><br /><span class="quiet">${escapeHtml(item.id)}</span></td>
            <td>${renderStatus(item.status)}</td>
            <td>${escapeHtml(item.created_by_agent_id ?? "-")}</td>
            <td>${escapeHtml(formatTimestamp(item.updated_at))}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderSelectOptions(
  items: Array<{ value: string; label: string }>,
  selectedValue: string | undefined,
): string {
  return items
    .map((item) => {
      const selected = (selectedValue ?? "") === item.value ? " selected" : "";
      return `<option value="${escapeHtml(item.value)}"${selected}>${escapeHtml(item.label)}</option>`;
    })
    .join("");
}

function renderBooleanOptions(selectedValue: boolean | undefined): string {
  return renderSelectOptions(
    [
      { value: "", label: "全部" },
      { value: "true", label: "仅高风险" },
      { value: "false", label: "仅非高风险" },
    ],
    typeof selectedValue === "boolean" ? String(selectedValue) : undefined,
  );
}

function renderSubtasksTable(items: SubtaskRecord[]): string {
  if (items.length === 0) {
    return `<p class="empty">还没有子任务。</p>`;
  }
  return `<table>
    <thead>
      <tr><th>名称</th><th>状态</th><th>角色</th><th>执行人</th><th>优先级 / 风险</th><th>更新时间</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td>
              <strong>${escapeHtml(item.name)}</strong><br />
              <span class="quiet">${escapeHtml(item.id)}</span><br />
              ${renderRiskFlag(item)}
            </td>
            <td>${renderStatus(item.status)}</td>
            <td>${escapeHtml(localizeRole(item.current_role))}</td>
            <td>${escapeHtml(item.assigned_agent_id ?? "-")}</td>
            <td>
              <span class="quiet">${escapeHtml(item.priority)}</span><br />
              <span class="quiet">${escapeHtml(item.risk_tags || "-")}</span>
            </td>
            <td>${escapeHtml(formatTimestamp(item.updated_at))}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderObservationTable(items: SubtaskRecord[]): string {
  if (items.length === 0) {
    return `<p class="empty">当前没有需要重点观察的子任务。</p>`;
  }
  return `<table>
    <thead>
      <tr><th>子任务</th><th>角色 / 状态</th><th>证据</th><th>交接 / 风险</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td>
              <strong>${escapeHtml(item.name)}</strong><br />
              <span class="quiet">${escapeHtml(item.id)}</span><br />
              ${renderRiskFlag(item)}<br />
              <span class="quiet">Agent ${escapeHtml(item.assigned_agent_id ?? "-")}</span>
            </td>
            <td>
              ${renderStatus(item.status)}<br />
              <span class="quiet">角色 ${escapeHtml(localizeRole(item.current_role))}</span><br />
              <span class="quiet">更新 ${escapeHtml(formatTimestamp(item.updated_at))}</span>
            </td>
            <td>
              <span class="quiet">提交 ${escapeHtml(item.latest_commit_ref || "-")}</span><br />
              <span class="quiet">Base ${escapeHtml(item.base_ref || "-")}</span><br />
              <span class="quiet">分支 ${escapeHtml(item.branch_ref || "-")}</span><br />
              <span class="quiet">测试 ${escapeHtml(item.test_summary || "-")}</span><br />
              <span class="quiet">交付 ${escapeHtml(item.delivery_summary || "-")}</span>
            </td>
            <td>
              <span class="quiet">标签 ${escapeHtml(item.risk_tags || "-")}</span><br />
              <span class="quiet">交接 ${escapeHtml(item.handoff_summary || "-")}</span><br />
              <span class="quiet">风险 ${escapeHtml(item.risk_summary || "-")}</span><br />
              <span class="quiet">变更 ${escapeHtml(item.change_summary || "-")}</span>
            </td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderStageGates(
  basePath: string,
  currentFilters: {
    taskStatus?: string;
    subtaskStatus?: string;
    currentRole?: string;
    highRisk?: boolean;
    observationRole?: string;
    observationHighRisk?: boolean;
    activityAction?: string;
  },
  stageGates: StageGateSummary,
): string {
  const stage1 = stageGates.stage_1.map((item) => ({
    ...item,
    href: stageGateHref(basePath, currentFilters, item.key),
  }));
  const stage2 = stageGates.stage_2.map((item) => ({
    ...item,
    href: stageGateHref(basePath, currentFilters, item.key),
  }));
  return `
    <div class="forms">
      <div class="panel" style="padding: 14px; background: rgba(255,255,255,0.7);">
        <h3 style="margin: 0 0 10px;">阶段 1 ${stageGates.stage_1_passed ? "通过" : "未通过"}</h3>
        ${renderStageGateTable(stage1)}
      </div>
      <div class="panel" style="padding: 14px; background: rgba(255,255,255,0.7);">
        <h3 style="margin: 0 0 10px;">阶段 2 ${stageGates.stage_2_passed ? "通过" : "未通过"}</h3>
        ${renderStageGateTable(stage2)}
      </div>
      <p class="hint">人工接管、线程重绑、评审超时接管可通过 <code>log_activity</code> 记录标准动作名：<code>manual_takeover</code>、<code>thread_rebound</code>、<code>review_timeout_takeover</code>。</p>
    </div>
  `;
}

function renderStageGateTable(
  items: Array<{ label: string; passed: boolean; value: string; target: string; href?: string }>,
): string {
  return `<table>
    <thead>
      <tr><th>指标</th><th>当前值</th><th>门槛</th><th>结果</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td>${renderLinkedText(item.label, item.href)}</td>
            <td>${escapeHtml(item.value)}</td>
            <td>${escapeHtml(item.target)}</td>
            <td>${item.passed ? '<span class="status">通过</span>' : '<span class="status status-blocked">未通过</span>'}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderReviewsTable(items: ReviewRecord[]): string {
  if (items.length === 0) {
    return `<p class="empty">还没有评审记录。</p>`;
  }
  return `<table>
    <thead>
      <tr><th>子任务</th><th>结果</th><th>评审人</th><th>评分</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td>${escapeHtml(item.subtask_id)}</td>
            <td>${renderStatus(item.result)}</td>
            <td>${escapeHtml(item.reviewer_agent_id)}</td>
            <td>${escapeHtml(String(item.score))}/5</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderActivityTable(items: ActivityLogRecord[]): string {
  if (items.length === 0) {
    return `<p class="empty">还没有活动记录。</p>`;
  }
  return `<table>
    <thead>
      <tr><th>动作</th><th>Agent</th><th>子任务</th><th>时间</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td><strong>${escapeHtml(item.action)}</strong><br /><span class="quiet">${escapeHtml(item.summary)}</span></td>
            <td>${escapeHtml(item.agent_id ?? "-")}</td>
            <td>${escapeHtml(item.subtask_id ?? "-")}</td>
            <td>${escapeHtml(formatTimestamp(item.created_at))}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderStatus(value: string): string {
  const normalized = value.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `<span class="status status-${escapeHtml(normalized)}">${escapeHtml(localizeStatus(value))}</span>`;
}

function renderRiskFlag(item: SubtaskRecord): string {
  if (!item.is_high_risk) {
    return `<span class="quiet">普通风险</span>`;
  }
  return `<span class="risk-flag">高风险</span>`;
}

function renderLinkedText(text: string, href?: string): string {
  if (!href) {
    return escapeHtml(text);
  }
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

function renderInlineLink(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function buildDashboardHref(
  basePath: string,
  current: {
    taskStatus?: string;
    subtaskStatus?: string;
    currentRole?: string;
    highRisk?: boolean;
    observationRole?: string;
    observationHighRisk?: boolean;
    activityAction?: string;
  },
  patch: {
    taskStatus?: string;
    subtaskStatus?: string;
    currentRole?: string;
    highRisk?: boolean;
    observationRole?: string;
    observationHighRisk?: boolean;
    activityAction?: string;
  },
  anchor?: string,
): string {
  const params = new URLSearchParams();
  const merged = {
    ...current,
    ...patch,
  };
  setQueryValue(params, "taskStatus", merged.taskStatus);
  setQueryValue(params, "subtaskStatus", merged.subtaskStatus);
  setQueryValue(params, "currentRole", merged.currentRole);
  setQueryBoolean(params, "highRisk", merged.highRisk);
  setQueryValue(params, "observationRole", merged.observationRole);
  setQueryBoolean(params, "observationHighRisk", merged.observationHighRisk);
  setQueryValue(params, "activityAction", merged.activityAction);
  const query = params.toString();
  return `${basePath}/${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}`;
}

function stageGateHref(
  basePath: string,
  currentFilters: {
    taskStatus?: string;
    subtaskStatus?: string;
    currentRole?: string;
    highRisk?: boolean;
    observationRole?: string;
    observationHighRisk?: boolean;
    activityAction?: string;
  },
  key: string,
): string | undefined {
  switch (key) {
    case "completed_runs":
      return buildDashboardHref(basePath, currentFilters, { subtaskStatus: "done" }, "subtasks-panel");
    case "review_timeout_takeovers":
      return buildDashboardHref(
        basePath,
        currentFilters,
        { activityAction: "review_timeout_takeover" },
        "activity-panel",
      );
    case "rework_rate":
      return buildDashboardHref(
        basePath,
        currentFilters,
        { subtaskStatus: "rework", currentRole: "executor", observationRole: "reviewer" },
        "qa-panel",
      );
    case "thread_rebinds":
      return buildDashboardHref(
        basePath,
        currentFilters,
        { activityAction: "thread_rebound" },
        "activity-panel",
      );
    case "manual_takeovers":
      return buildDashboardHref(
        basePath,
        currentFilters,
        { activityAction: "manual_takeover" },
        "activity-panel",
      );
    case "avg_review_wait":
      return buildDashboardHref(
        basePath,
        currentFilters,
        { subtaskStatus: "review", currentRole: "reviewer", observationRole: "reviewer" },
        "qa-panel",
      );
    case "blocked_sla":
      return buildDashboardHref(
        basePath,
        currentFilters,
        { subtaskStatus: "blocked", observationRole: "patrol" },
        "ops-panel",
      );
    default:
      return undefined;
  }
}

function setQueryValue(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value?.trim()) {
    params.set(key, value.trim());
  }
}

function setQueryBoolean(params: URLSearchParams, key: string, value: boolean | undefined): void {
  if (typeof value === "boolean") {
    params.set(key, String(value));
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localizeRoleBindings(value: string): string {
  return value
    .replaceAll("planner", "规划")
    .replaceAll("reviewer", "评审")
    .replaceAll("patrol", "巡检")
    .replaceAll("executor", "执行")
    .replaceAll("not configured", "未配置");
}

function localizeRole(value: string | null): string {
  switch (value) {
    case "planner":
      return "规划";
    case "reviewer":
      return "评审";
    case "patrol":
      return "巡检";
    case "executor":
      return "执行";
    default:
      return value ?? "-";
  }
}

function formatMetricNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function formatMetricMinutes(value: number | null): string {
  return value === null ? "-" : `${value} 分钟`;
}

function formatMetricPercent(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function localizeStatus(value: string): string {
  switch (value) {
    case "planning":
      return "规划中";
    case "active":
      return "进行中";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "pending":
      return "待领取";
    case "assigned":
      return "已分配";
    case "in_progress":
      return "执行中";
    case "review":
      return "待评审";
    case "rework":
      return "返工中";
    case "blocked":
      return "阻塞";
    case "done":
      return "完成";
    case "approved":
      return "通过";
    case "rejected":
      return "驳回";
    default:
      return value;
  }
}
