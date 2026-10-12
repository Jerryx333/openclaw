import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { inferWorkflowRole } from "./config.js";
import { getWorkflowStore } from "./db.js";
import { planSubtasksForTask } from "./planner.js";

export function createWorkflowTool(params: {
  api: OpenClawPluginApi;
  context: OpenClawPluginToolContext;
}) {
  const store = getWorkflowStore(params.api.pluginConfig, params.api.logger);
  const role = inferWorkflowRole(params.context.agentId, params.api.pluginConfig);

  return {
    name: "workflow",
    label: "Workflow",
    description:
      "Manage a lightweight task workflow for planner/executor/reviewer/patrol loops. Supports queue pulls, task creation, subtask state transitions, reviews, and activity logging.",
    parameters: Type.Object({
      action: Type.String({ description: "Workflow action to execute." }),
      taskId: Type.Optional(Type.String()),
      subtaskId: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      deliverable: Type.Optional(Type.String()),
      acceptance: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
      currentRole: Type.Optional(Type.String()),
      highRisk: Type.Optional(Type.Boolean()),
      isHighRisk: Type.Optional(Type.Boolean()),
      riskTags: Type.Optional(Type.String()),
      assignedAgentId: Type.Optional(Type.String()),
      plan: Type.Optional(Type.String()),
      persist: Type.Optional(Type.Boolean()),
      result: Type.Optional(Type.String({ description: "approved or rejected" })),
      score: Type.Optional(Type.Number()),
      issues: Type.Optional(Type.String()),
      comment: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      actionName: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      commitRef: Type.Optional(Type.String()),
      changeSummary: Type.Optional(Type.String()),
      testSummary: Type.Optional(Type.String()),
      deliverySummary: Type.Optional(Type.String()),
      riskSummary: Type.Optional(Type.String()),
      baseRef: Type.Optional(Type.String()),
      branchRef: Type.Optional(Type.String()),
      handoffSummary: Type.Optional(Type.String()),
      resolutionSummary: Type.Optional(Type.String()),
    }),
    async execute(_id: string, raw: Record<string, unknown>) {
      const action = requireString(raw.action, "action");
      const actorAgentId = params.context.agentId?.trim();
      const actor = {
        agentId: actorAgentId,
        sessionKey: params.context.sessionKey,
      };

      let result: unknown;
      switch (action) {
        case "pull_queue":
          result = store.pullQueue({ agentId: actorAgentId, role });
          break;
        case "queue_summary":
          result = store.queueSummary();
          break;
        case "stage_gates":
          result = store.stageGateSummary();
          break;
        case "list_tasks":
          result = store.listTasks({
            status: optionalString(raw.status),
            limit: optionalPositiveInt(raw.limit),
          });
          break;
        case "get_task":
          result = store.getTask(requireString(raw.taskId, "taskId"));
          break;
        case "create_task":
          requireRole(role, ["planner"], action);
          result = store.createTask({
            name: requireString(raw.name, "name"),
            description: optionalString(raw.description),
            actor,
          });
          break;
        case "create_subtask":
          requireRole(role, ["planner"], action);
          result = store.createSubtask({
            taskId: requireString(raw.taskId, "taskId"),
            name: requireString(raw.name, "name"),
            description: optionalString(raw.description),
            deliverable: optionalString(raw.deliverable),
            acceptance: optionalString(raw.acceptance),
            priority: optionalString(raw.priority),
            assignedAgentId: optionalString(raw.assignedAgentId),
            isHighRisk: optionalBoolean(raw.isHighRisk),
            riskTags: optionalString(raw.riskTags),
            actor,
          });
          break;
        case "plan_subtasks": {
          requireRole(role, ["planner"], action);
          const taskId = requireString(raw.taskId, "taskId");
          const task = store.getTask(taskId);
          if (!task) {
            throw new Error(`task not found: ${taskId}`);
          }
          const drafts = planSubtasksForTask({
            task,
            source: optionalString(raw.plan),
            defaultAssignedAgentId: optionalString(raw.assignedAgentId),
            existingSubtasks: store.listSubtasks({ taskId }),
          });
          const persist = optionalBoolean(raw.persist) ?? false;
          const created = persist
            ? drafts.map((draft) =>
                store.createSubtask({
                  taskId,
                  name: draft.name,
                  description: draft.description,
                  deliverable: draft.deliverable,
                  acceptance: draft.acceptance,
                  priority: draft.priority,
                  isHighRisk: draft.isHighRisk,
                  riskTags: draft.riskTags,
                  assignedAgentId: draft.assignedAgentId,
                  actor,
                }),
              )
            : [];
          result = {
            task,
            drafts,
            persisted: persist,
            created,
          };
          break;
        }
        case "list_subtasks":
          result = store.listSubtasks({
            taskId: optionalString(raw.taskId),
            status: optionalString(raw.status),
            assignedAgentId: optionalString(raw.assignedAgentId),
            currentRole: optionalString(raw.currentRole),
            highRisk: optionalBoolean(raw.highRisk),
            limit: optionalPositiveInt(raw.limit),
          });
          break;
        case "get_subtask":
          result = store.getSubtask(requireString(raw.subtaskId, "subtaskId"));
          break;
        case "claim_subtask":
          requireRole(role, ["executor"], action);
          result = store.claimSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            sessionKey: params.context.sessionKey,
          });
          break;
        case "start_subtask":
          requireRole(role, ["executor"], action);
          result = store.startSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            sessionKey: params.context.sessionKey,
          });
          break;
        case "submit_subtask":
          requireRole(role, ["executor"], action);
          result = store.submitSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            commitRef: optionalString(raw.commitRef),
            changeSummary: optionalString(raw.changeSummary),
            testSummary: optionalString(raw.testSummary),
            deliverySummary: optionalString(raw.deliverySummary),
            riskSummary: optionalString(raw.riskSummary),
            isHighRisk: optionalBoolean(raw.isHighRisk),
            riskTags: optionalString(raw.riskTags),
            baseRef: optionalString(raw.baseRef),
            branchRef: optionalString(raw.branchRef),
          });
          break;
        case "handoff_subtask":
          requireRole(role, ["executor"], action);
          result = store.handoffSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            baseRef: optionalString(raw.baseRef),
            branchRef: optionalString(raw.branchRef),
            commitRef: optionalString(raw.commitRef),
            testSummary: optionalString(raw.testSummary),
            handoffSummary: requireString(raw.handoffSummary, "handoffSummary"),
            riskSummary: optionalString(raw.riskSummary),
            isHighRisk: optionalBoolean(raw.isHighRisk),
            riskTags: optionalString(raw.riskTags),
          });
          break;
        case "review_subtask":
          requireRole(role, ["reviewer"], action);
          result = store.reviewSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            reviewerAgentId: requireActor(actorAgentId),
            result: normalizeReviewResult(raw.result),
            score: requireNumber(raw.score, "score"),
            issues: optionalString(raw.issues),
            comment: optionalString(raw.comment),
            reworkAgentId: optionalString(raw.assignedAgentId),
          });
          break;
        case "block_subtask":
          requireRole(role, ["patrol", "planner"], action);
          result = store.blockSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            summary: optionalString(raw.summary),
          });
          break;
        case "unblock_subtask":
          requireRole(role, ["patrol", "planner"], action);
          result = store.unblockSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            resolution: requireString(raw.resolutionSummary ?? raw.summary, "resolutionSummary"),
            assignedAgentId: optionalString(raw.assignedAgentId),
          });
          break;
        case "reassign_subtask":
          requireRole(role, ["planner"], action);
          result = store.reassignSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            assignedAgentId: requireString(raw.assignedAgentId, "assignedAgentId"),
          });
          break;
        case "cancel_subtask":
          requireRole(role, ["planner"], action);
          result = store.cancelSubtask({
            subtaskId: requireString(raw.subtaskId, "subtaskId"),
            agentId: requireActor(actorAgentId),
            summary: optionalString(raw.summary),
          });
          break;
        case "log_activity":
          result = store.createActivity({
            agentId: actorAgentId,
            subtaskId: optionalString(raw.subtaskId),
            action: requireString(raw.actionName ?? raw.status ?? raw.action, "actionName"),
            summary: requireString(raw.summary, "summary"),
            sessionKey: params.context.sessionKey,
          });
          break;
        default:
          throw new Error(`unknown workflow action: ${action}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, action, role, result }, null, 2) }],
        details: { action, role, result },
      };
    },
  };
}

function requireActor(agentId: string | undefined): string {
  if (!agentId?.trim()) {
    throw new Error("workflow action requires an agentId-bound session");
  }
  return agentId;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeReviewResult(value: unknown): "approved" | "rejected" {
  if (value === "approved" || value === "rejected") {
    return value;
  }
  throw new Error('result must be either "approved" or "rejected"');
}

function requireRole(
  actual: string,
  allowed: Array<"planner" | "executor" | "reviewer" | "patrol">,
  action: string,
): void {
  if (!allowed.includes(actual as (typeof allowed)[number])) {
    throw new Error(`workflow action ${action} requires role=${allowed.join(" or ")}, got ${actual}`);
  }
}
