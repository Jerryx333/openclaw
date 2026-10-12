import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PluginLogger } from "../api.js";
import { resolveWorkflowConfig, resolveWorkflowDbPath } from "./config.js";
import type {
  ActivityLogRecord,
  GovernanceMetrics,
  ReviewRecord,
  ReviewResult,
  StageGateCheck,
  StageGateSummary,
  SubtaskRecord,
  SubtaskStatus,
  TaskRecord,
  WorkflowPluginConfig,
  WorkflowRole,
} from "./schema.js";

type MutationActor = {
  agentId?: string;
  sessionKey?: string;
};

type SqlArg = string | number | null;

type ListFilters = {
  status?: string;
  taskId?: string;
  assignedAgentId?: string;
  currentRole?: string;
  highRisk?: boolean;
  action?: string;
  limit?: number;
};

type PullQueueResult = {
  role: WorkflowRole;
  agentId?: string;
  tasks?: TaskRecord[];
  subtasks?: SubtaskRecord[];
  stale?: {
    assigned: SubtaskRecord[];
    in_progress: SubtaskRecord[];
  };
  counts: {
    tasks: number;
    subtasks: number;
    blocked: number;
    review: number;
  };
};

type QueueSummary = {
  tasks: {
    total: number;
    planning: number;
    active: number;
    completed: number;
    cancelled: number;
  };
  subtasks: {
    total: number;
    pending: number;
    assigned: number;
    in_progress: number;
    review: number;
    rework: number;
    blocked: number;
    done: number;
    cancelled: number;
  };
  stale: {
    assigned: number;
    in_progress: number;
  };
};

let cachedStore: WorkflowStore | null = null;
let cachedPath = "";

const LOOKBACK_DAYS = 7;
const REVIEW_WAIT_SLA_MINUTES = 120;
const BLOCKED_SLA_MINUTES = 240;
const STAGE_1_MIN_DONE_SUBTASKS = 3;
const STAGE_1_MAX_REVIEW_TIMEOUT_TAKEOVERS = 1;
const STAGE_1_MAX_REWORK_RATE = 0.34;
const STAGE_2_MAX_THREAD_REBINDS = 2;
const STAGE_2_MAX_MANUAL_TAKEOVERS = 3;

export function getWorkflowStore(configInput: unknown, logger?: PluginLogger): WorkflowStore {
  const dbPath = resolveWorkflowDbPath(configInput);
  if (!cachedStore || cachedPath !== dbPath) {
    cachedStore?.close();
    cachedStore = new WorkflowStore({
      dbPath,
      config: resolveWorkflowConfig(configInput),
      logger,
    });
    cachedPath = dbPath;
  }
  return cachedStore;
}

export function resetWorkflowStoreForTests(): void {
  cachedStore?.close();
  cachedStore = null;
  cachedPath = "";
}

export class WorkflowStore {
  private readonly db: DatabaseSync;
  private readonly config: Required<WorkflowPluginConfig>;
  private readonly logger?: PluginLogger;

  constructor(params: {
    dbPath: string;
    config: Required<WorkflowPluginConfig>;
    logger?: PluginLogger;
  }) {
    fs.mkdirSync(path.dirname(params.dbPath), { recursive: true });
    this.db = new DatabaseSync(params.dbPath);
    this.config = params.config;
    this.logger = params.logger;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  createTask(input: {
    name: string;
    description?: string;
    actor?: MutationActor;
  }): TaskRecord {
    const name = input.name.trim();
    if (!name) {
      throw new Error("task name is required");
    }
    const now = isoNow();
    const row = {
      id: randomUUID(),
      name,
      description: (input.description ?? "").trim(),
      status: "planning",
      created_by_agent_id: input.actor?.agentId?.trim() || null,
      created_at: now,
      updated_at: now,
    } satisfies TaskRecord;
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, name, description, status, created_by_agent_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.status,
        row.created_by_agent_id,
        row.created_at,
        row.updated_at,
      );
    this.insertActivity({
      agentId: input.actor?.agentId,
      action: "task_created",
      summary: `Created task "${row.name}"`,
      sessionKey: input.actor?.sessionKey,
    });
    return row;
  }

  listTasks(filters: ListFilters = {}): TaskRecord[] {
    const where: string[] = [];
    const args: SqlArg[] = [];
    if (filters.status) {
      where.push("status = ?");
      args.push(filters.status);
    }
    let sql = "SELECT * FROM tasks";
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += " ORDER BY updated_at DESC";
    if (filters.limit && filters.limit > 0) {
      sql += " LIMIT ?";
      args.push(filters.limit);
    }
    return this.db.prepare(sql).all(...args) as TaskRecord[];
  }

  getTask(taskId: string): TaskRecord | null {
    return (
      (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRecord | undefined) ??
      null
    );
  }

  createSubtask(input: {
    taskId: string;
    name: string;
    description?: string;
    deliverable?: string;
    acceptance?: string;
    priority?: string;
    assignedAgentId?: string;
    isHighRisk?: boolean;
    riskTags?: string;
    actor?: MutationActor;
  }): SubtaskRecord {
    const task = this.getTask(input.taskId);
    if (!task) {
      throw new Error(`task not found: ${input.taskId}`);
    }
    if (task.status === "cancelled") {
      throw new Error("cannot add a subtask to a cancelled task");
    }
    const name = input.name.trim();
    if (!name) {
      throw new Error("subtask name is required");
    }
    const now = isoNow();
    const status: SubtaskStatus = input.assignedAgentId?.trim() ? "assigned" : "pending";
    const riskState = deriveRiskSignals({
      explicitHighRisk: input.isHighRisk,
      explicitRiskTags: input.riskTags,
      fields: [
        task.name,
        input.name,
        input.description,
        input.deliverable,
        input.acceptance,
        input.priority,
      ],
      priority: input.priority,
    });
    const row = {
      id: randomUUID(),
      task_id: input.taskId,
      name,
      description: (input.description ?? "").trim(),
      deliverable: (input.deliverable ?? "").trim(),
      acceptance: (input.acceptance ?? "").trim(),
      priority: (input.priority ?? "medium").trim() || "medium",
      status,
      current_role: roleForSubtaskStatus(status),
      assigned_agent_id: input.assignedAgentId?.trim() || null,
      current_session_key: null,
      is_high_risk: riskState.isHighRisk,
      risk_tags: riskState.riskTags,
      base_ref: "",
      branch_ref: "",
      latest_commit_ref: "",
      change_summary: "",
      test_summary: "",
      delivery_summary: "",
      risk_summary: "",
      handoff_summary: "",
      review_requested_at: null,
      blocked_at: null,
      blocked_by_agent_id: null,
      blocked_reason: "",
      blocked_resolution: "",
      rework_count: 0,
      created_by_agent_id: input.actor?.agentId?.trim() || null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    } satisfies SubtaskRecord;
    this.db
      .prepare(
        `INSERT INTO subtasks (
          id, task_id, name, description, deliverable, acceptance, priority, status,
          current_role, assigned_agent_id, current_session_key, is_high_risk, risk_tags,
          base_ref, branch_ref, latest_commit_ref, change_summary, test_summary,
          delivery_summary, risk_summary, handoff_summary, review_requested_at, blocked_at,
          blocked_by_agent_id, blocked_reason, blocked_resolution, rework_count,
          created_by_agent_id, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.task_id,
        row.name,
        row.description,
        row.deliverable,
        row.acceptance,
        row.priority,
        row.status,
        row.current_role,
        row.assigned_agent_id,
        row.current_session_key,
        row.is_high_risk ? 1 : 0,
        row.risk_tags,
        row.base_ref,
        row.branch_ref,
        row.latest_commit_ref,
        row.change_summary,
        row.test_summary,
        row.delivery_summary,
        row.risk_summary,
        row.handoff_summary,
        row.review_requested_at,
        row.blocked_at,
        row.blocked_by_agent_id,
        row.blocked_reason,
        row.blocked_resolution,
        row.rework_count,
        row.created_by_agent_id,
        row.created_at,
        row.updated_at,
        row.completed_at,
      );
    this.touchTaskStatus(input.taskId, "active");
    this.insertActivity({
      agentId: input.actor?.agentId,
      subtaskId: row.id,
      action: "subtask_created",
      summary: `Created subtask "${row.name}"`,
      sessionKey: input.actor?.sessionKey,
    });
    return row;
  }

  listSubtasks(filters: ListFilters = {}): SubtaskRecord[] {
    const where: string[] = [];
    const args: SqlArg[] = [];
    if (filters.status) {
      where.push("status = ?");
      args.push(filters.status);
    }
    if (filters.taskId) {
      where.push("task_id = ?");
      args.push(filters.taskId);
    }
    if (filters.assignedAgentId) {
      where.push("assigned_agent_id = ?");
      args.push(filters.assignedAgentId);
    }
    if (filters.currentRole) {
      where.push("current_role = ?");
      args.push(filters.currentRole);
    }
    if (typeof filters.highRisk === "boolean") {
      where.push("is_high_risk = ?");
      args.push(filters.highRisk ? 1 : 0);
    }
    let sql = "SELECT * FROM subtasks";
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += " ORDER BY updated_at DESC";
    if (filters.limit && filters.limit > 0) {
      sql += " LIMIT ?";
      args.push(filters.limit);
    }
    return (this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map((row) =>
      this.mapSubtaskRow(row),
    );
  }

  getSubtask(subtaskId: string): SubtaskRecord | null {
    const row = this.db
      .prepare("SELECT * FROM subtasks WHERE id = ?")
      .get(subtaskId) as Record<string, unknown> | undefined;
    return row ? this.mapSubtaskRow(row) : null;
  }

  claimSubtask(input: {
    subtaskId: string;
    agentId: string;
    sessionKey?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    if (subtask.status !== "pending" && !(subtask.status === "assigned" && subtask.assigned_agent_id === input.agentId)) {
      throw new Error(`cannot claim subtask in status ${subtask.status}`);
    }
    this.updateSubtask(subtask.id, {
      status: "assigned",
      assigned_agent_id: input.agentId,
      current_session_key: input.sessionKey ?? subtask.current_session_key,
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_claimed",
      summary: `Claimed subtask "${subtask.name}"`,
      sessionKey: input.sessionKey,
    });
    return this.requireSubtask(subtask.id);
  }

  startSubtask(input: {
    subtaskId: string;
    agentId: string;
    sessionKey?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    this.assertAssignedExecutor(subtask, input.agentId);
    if (subtask.status !== "assigned" && subtask.status !== "rework") {
      throw new Error(`cannot start subtask in status ${subtask.status}`);
    }
    this.updateSubtask(subtask.id, {
      status: "in_progress",
      current_session_key: input.sessionKey ?? subtask.current_session_key,
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_started",
      summary: `Started subtask "${subtask.name}"`,
      sessionKey: input.sessionKey,
    });
    return this.requireSubtask(subtask.id);
  }

  submitSubtask(input: {
    subtaskId: string;
    agentId: string;
    commitRef?: string;
    changeSummary?: string;
    testSummary?: string;
    deliverySummary?: string;
    riskSummary?: string;
    isHighRisk?: boolean;
    riskTags?: string;
    baseRef?: string;
    branchRef?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    this.assertAssignedExecutor(subtask, input.agentId);
    if (subtask.status !== "in_progress") {
      throw new Error(`cannot submit subtask in status ${subtask.status}`);
    }
    const commitRef = input.commitRef?.trim() || subtask.latest_commit_ref;
    const changeSummary = input.changeSummary?.trim() || subtask.change_summary;
    const testSummary = input.testSummary?.trim() || subtask.test_summary;
    const deliverySummary = input.deliverySummary?.trim() || subtask.delivery_summary;
    const riskState = deriveRiskSignals({
      explicitHighRisk: input.isHighRisk,
      explicitRiskTags: input.riskTags,
      currentHighRisk: subtask.is_high_risk,
      currentRiskTags: subtask.risk_tags,
      fields: [
        subtask.name,
        subtask.description,
        subtask.deliverable,
        subtask.acceptance,
        changeSummary,
        testSummary,
        deliverySummary,
        input.riskSummary,
        input.baseRef,
        input.branchRef,
      ],
      priority: subtask.priority,
    });
    if (!commitRef && !changeSummary) {
      throw new Error("submit_subtask requires commitRef or changeSummary");
    }
    if (!testSummary) {
      throw new Error("submit_subtask requires testSummary");
    }
    if (!deliverySummary) {
      throw new Error("submit_subtask requires deliverySummary");
    }
    this.updateSubtask(subtask.id, {
      status: "review",
      latest_commit_ref: commitRef,
      change_summary: changeSummary,
      test_summary: testSummary,
      delivery_summary: deliverySummary,
      risk_summary: input.riskSummary?.trim() || subtask.risk_summary,
      is_high_risk: riskState.isHighRisk,
      risk_tags: riskState.riskTags,
      base_ref: input.baseRef?.trim() || subtask.base_ref,
      branch_ref: input.branchRef?.trim() || subtask.branch_ref,
      handoff_summary: "",
      review_requested_at: isoNow(),
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_submitted",
      summary: `Submitted subtask "${subtask.name}" for review`,
      sessionKey: subtask.current_session_key ?? undefined,
    });
    return this.requireSubtask(subtask.id);
  }

  handoffSubtask(input: {
    subtaskId: string;
    agentId: string;
    baseRef?: string;
    branchRef?: string;
    commitRef?: string;
    testSummary?: string;
    handoffSummary: string;
    riskSummary?: string;
    isHighRisk?: boolean;
    riskTags?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    this.assertAssignedExecutor(subtask, input.agentId);
    if (!["assigned", "in_progress", "rework", "blocked"].includes(subtask.status)) {
      throw new Error(`cannot hand off subtask in status ${subtask.status}`);
    }
    const handoffSummary = input.handoffSummary.trim();
    if (!handoffSummary) {
      throw new Error("handoffSummary is required");
    }
    const riskState = deriveRiskSignals({
      explicitHighRisk: input.isHighRisk,
      explicitRiskTags: input.riskTags,
      currentHighRisk: subtask.is_high_risk,
      currentRiskTags: subtask.risk_tags,
      fields: [
        subtask.name,
        subtask.description,
        subtask.deliverable,
        subtask.acceptance,
        input.testSummary,
        input.handoffSummary,
        input.riskSummary,
        input.baseRef,
        input.branchRef,
      ],
      priority: subtask.priority,
    });
    this.updateSubtask(subtask.id, {
      base_ref: input.baseRef?.trim() || subtask.base_ref,
      branch_ref: input.branchRef?.trim() || subtask.branch_ref,
      latest_commit_ref: input.commitRef?.trim() || subtask.latest_commit_ref,
      test_summary: input.testSummary?.trim() || subtask.test_summary,
      risk_summary: input.riskSummary?.trim() || subtask.risk_summary,
      is_high_risk: riskState.isHighRisk,
      risk_tags: riskState.riskTags,
      handoff_summary: handoffSummary,
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_handoff_recorded",
      summary: `Recorded handoff for "${subtask.name}"`,
      sessionKey: subtask.current_session_key ?? undefined,
    });
    return this.requireSubtask(subtask.id);
  }

  reviewSubtask(input: {
    subtaskId: string;
    reviewerAgentId: string;
    result: ReviewResult;
    score: number;
    issues?: string;
    comment?: string;
    reworkAgentId?: string;
  }): { subtask: SubtaskRecord; review: ReviewRecord } {
    const subtask = this.requireSubtask(input.subtaskId);
    if (subtask.status !== "review") {
      throw new Error(`cannot review subtask in status ${subtask.status}`);
    }
    if (!Number.isFinite(input.score) || input.score < 1 || input.score > 5) {
      throw new Error("score must be between 1 and 5");
    }
    if (input.result === "rejected" && !input.issues?.trim()) {
      throw new Error("issues are required when rejecting a subtask");
    }
    const review = {
      id: randomUUID(),
      subtask_id: subtask.id,
      reviewer_agent_id: input.reviewerAgentId,
      result: input.result,
      score: Math.floor(input.score),
      wait_minutes: subtask.review_requested_at
        ? Math.max(
            0,
            Math.floor((Date.now() - new Date(subtask.review_requested_at).getTime()) / 60_000),
          )
        : null,
      issues: (input.issues ?? "").trim(),
      comment: (input.comment ?? "").trim(),
      created_at: isoNow(),
    } satisfies ReviewRecord;
    this.db
      .prepare(
        `INSERT INTO reviews (
          id, subtask_id, reviewer_agent_id, result, score, wait_minutes, issues, comment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        review.subtask_id,
        review.reviewer_agent_id,
        review.result,
        review.score,
        review.wait_minutes,
        review.issues,
        review.comment,
        review.created_at,
      );
    if (input.result === "approved") {
      this.updateSubtask(subtask.id, {
        status: "done",
        review_requested_at: null,
        completed_at: isoNow(),
      });
    } else {
      this.updateSubtask(subtask.id, {
        status: "rework",
        assigned_agent_id: input.reworkAgentId?.trim() || subtask.assigned_agent_id,
        rework_count: subtask.rework_count + 1,
        current_session_key: null,
        review_requested_at: null,
      });
    }
    this.insertActivity({
      agentId: input.reviewerAgentId,
      subtaskId: subtask.id,
      action: "subtask_reviewed",
      summary: `${input.result === "approved" ? "Approved" : "Rejected"} "${subtask.name}" (${review.score}/5)`,
    });
    this.syncTaskStatus(subtask.task_id);
    return {
      subtask: this.requireSubtask(subtask.id),
      review,
    };
  }

  blockSubtask(input: {
    subtaskId: string;
    agentId: string;
    summary?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    if (!["assigned", "in_progress", "rework"].includes(subtask.status)) {
      throw new Error(`cannot block subtask in status ${subtask.status}`);
    }
    this.updateSubtask(subtask.id, {
      status: "blocked",
      current_session_key: null,
      blocked_at: isoNow(),
      blocked_by_agent_id: input.agentId,
      blocked_reason: input.summary?.trim() || `Blocked "${subtask.name}"`,
      blocked_resolution: "",
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_blocked",
      summary: input.summary?.trim() || `Blocked "${subtask.name}"`,
      sessionKey: subtask.current_session_key ?? undefined,
    });
    return this.requireSubtask(subtask.id);
  }

  unblockSubtask(input: {
    subtaskId: string;
    agentId: string;
    resolution: string;
    assignedAgentId?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    if (subtask.status !== "blocked") {
      throw new Error(`cannot unblock subtask in status ${subtask.status}`);
    }
    const resolution = input.resolution.trim();
    if (!resolution) {
      throw new Error("resolution is required");
    }
    const assignedAgentId = input.assignedAgentId?.trim() || subtask.assigned_agent_id;
    this.updateSubtask(subtask.id, {
      status: assignedAgentId ? "assigned" : "pending",
      assigned_agent_id: assignedAgentId,
      current_session_key: null,
      blocked_resolution: resolution,
      blocked_at: null,
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_unblocked",
      summary: `Unblocked "${subtask.name}": ${resolution}`,
    });
    return this.requireSubtask(subtask.id);
  }

  reassignSubtask(input: {
    subtaskId: string;
    agentId: string;
    assignedAgentId: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    if (!["blocked", "pending", "assigned", "rework"].includes(subtask.status)) {
      throw new Error(`cannot reassign subtask in status ${subtask.status}`);
    }
    this.updateSubtask(subtask.id, {
      status: "assigned",
      assigned_agent_id: input.assignedAgentId.trim(),
      current_session_key: null,
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_reassigned",
      summary: `Reassigned "${subtask.name}" to ${input.assignedAgentId}`,
    });
    return this.requireSubtask(subtask.id);
  }

  createActivity(input: {
    agentId?: string;
    subtaskId?: string;
    action: string;
    summary: string;
    sessionKey?: string;
  }): ActivityLogRecord {
    if (!input.action.trim()) {
      throw new Error("action is required");
    }
    if (!input.summary.trim()) {
      throw new Error("summary is required");
    }
    return this.insertActivity(input);
  }

  cancelSubtask(input: {
    subtaskId: string;
    agentId: string;
    summary?: string;
  }): SubtaskRecord {
    const subtask = this.requireSubtask(input.subtaskId);
    if (subtask.status === "done" || subtask.status === "cancelled") {
      throw new Error(`cannot cancel subtask in status ${subtask.status}`);
    }
    this.updateSubtask(subtask.id, {
      status: "cancelled",
      current_session_key: null,
      completed_at: null,
    });
    this.insertActivity({
      agentId: input.agentId,
      subtaskId: subtask.id,
      action: "subtask_cancelled",
      summary: input.summary?.trim() || `Cancelled "${subtask.name}"`,
    });
    this.syncTaskStatus(subtask.task_id);
    return this.requireSubtask(subtask.id);
  }

  listReviews(filters: { subtaskId?: string; limit?: number } = {}): ReviewRecord[] {
    const where: string[] = [];
    const args: SqlArg[] = [];
    if (filters.subtaskId) {
      where.push("subtask_id = ?");
      args.push(filters.subtaskId);
    }
    let sql = "SELECT * FROM reviews";
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += " ORDER BY created_at DESC";
    if (filters.limit && filters.limit > 0) {
      sql += " LIMIT ?";
      args.push(filters.limit);
    }
    return this.db.prepare(sql).all(...args) as ReviewRecord[];
  }

  listActivity(filters: ListFilters = {}): ActivityLogRecord[] {
    const where: string[] = [];
    const args: SqlArg[] = [];
    if (filters.taskId) {
      where.push("subtask_id IN (SELECT id FROM subtasks WHERE task_id = ?)");
      args.push(filters.taskId);
    }
    if (filters.action) {
      where.push("action = ?");
      args.push(filters.action);
    }
    let sql = "SELECT * FROM activity_logs";
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += " ORDER BY created_at DESC";
    if (filters.limit && filters.limit > 0) {
      sql += " LIMIT ?";
      args.push(filters.limit);
    }
    return this.db.prepare(sql).all(...args) as ActivityLogRecord[];
  }

  pullQueue(params: { agentId?: string; role: WorkflowRole }): PullQueueResult {
    const tasks = params.role === "planner" ? this.listTasks({ limit: 25 }) : [];
    let subtasks: SubtaskRecord[] = [];
    let staleAssigned: SubtaskRecord[] = [];
    let staleInProgress: SubtaskRecord[] = [];

    switch (params.role) {
      case "planner":
        subtasks = this.sortSubtasksForGovernance(this.listSubtasks({ status: "blocked", limit: 25 }));
        break;
      case "reviewer":
        subtasks = this.sortSubtasksForGovernance(this.listSubtasks({ status: "review", limit: 25 }));
        break;
      case "patrol":
        staleAssigned = this.listStaleSubtasks("assigned", this.config.staleMinutes.assigned);
        staleInProgress = this.listStaleSubtasks(
          "in_progress",
          this.config.staleMinutes.inProgress,
        );
        subtasks = this.sortSubtasksForGovernance([...staleAssigned, ...staleInProgress]);
        break;
      case "executor":
      default:
        subtasks = this.sortSubtasksForGovernance([
          ...this.listSubtasks({
            assignedAgentId: params.agentId,
            limit: 20,
          }).filter((item) => ["assigned", "in_progress", "rework"].includes(item.status)),
          ...this.listSubtasks({ status: "pending", limit: 10 }),
        ]);
        break;
    }

    const blocked = this.scalarCount("SELECT COUNT(*) FROM subtasks WHERE status = 'blocked'");
    const review = this.scalarCount("SELECT COUNT(*) FROM subtasks WHERE status = 'review'");
    return {
      role: params.role,
      agentId: params.agentId,
      tasks,
      subtasks,
      stale:
        params.role === "patrol"
          ? {
              assigned: staleAssigned,
              in_progress: staleInProgress,
            }
          : undefined,
      counts: {
        tasks: tasks.length,
        subtasks: subtasks.length,
        blocked,
        review,
      },
    };
  }

  queueSummary(): QueueSummary {
    const taskCounts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'planning' THEN 1 ELSE 0 END) AS planning,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM tasks`,
      )
      .get() as Record<string, number | null>;
    const subtaskCounts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) AS assigned,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review,
          SUM(CASE WHEN status = 'rework' THEN 1 ELSE 0 END) AS rework,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM subtasks`,
      )
      .get() as Record<string, number | null>;

    return {
      tasks: {
        total: numberOrZero(taskCounts.total),
        planning: numberOrZero(taskCounts.planning),
        active: numberOrZero(taskCounts.active),
        completed: numberOrZero(taskCounts.completed),
        cancelled: numberOrZero(taskCounts.cancelled),
      },
      subtasks: {
        total: numberOrZero(subtaskCounts.total),
        pending: numberOrZero(subtaskCounts.pending),
        assigned: numberOrZero(subtaskCounts.assigned),
        in_progress: numberOrZero(subtaskCounts.in_progress),
        review: numberOrZero(subtaskCounts.review),
        rework: numberOrZero(subtaskCounts.rework),
        blocked: numberOrZero(subtaskCounts.blocked),
        done: numberOrZero(subtaskCounts.done),
        cancelled: numberOrZero(subtaskCounts.cancelled),
      },
      stale: {
        assigned: this.listStaleSubtasks("assigned", this.config.staleMinutes.assigned).length,
        in_progress: this.listStaleSubtasks("in_progress", this.config.staleMinutes.inProgress)
          .length,
      },
    };
  }

  governanceMetrics(): GovernanceMetrics {
    const sinceIso = lookbackIso(LOOKBACK_DAYS);
    const reviews = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total_reviews,
          SUM(CASE WHEN result = 'rejected' THEN 1 ELSE 0 END) AS rejected_reviews,
          AVG(score) AS avg_review_score,
          AVG(wait_minutes) AS avg_review_wait_minutes
         FROM reviews`,
      )
      .get() as Record<string, number | null>;
    const openSubtasks = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review_pending,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN is_high_risk = 1 AND status IN ('assigned', 'in_progress', 'review', 'rework', 'blocked') THEN 1 ELSE 0 END) AS high_risk_open,
          SUM(CASE WHEN is_high_risk = 1 AND status = 'review' THEN 1 ELSE 0 END) AS high_risk_review_pending,
          AVG(CASE WHEN status IN ('assigned', 'in_progress', 'review', 'rework', 'blocked') THEN rework_count ELSE NULL END) AS avg_rework_count_open
         FROM subtasks`,
      )
      .get() as Record<string, number | null>;
    const oldestReview = this.db
      .prepare(
        "SELECT review_requested_at FROM subtasks WHERE status = 'review' ORDER BY review_requested_at ASC LIMIT 1",
      )
      .get() as { review_requested_at?: string } | undefined;
    const oldestBlocked = this.db
      .prepare("SELECT blocked_at FROM subtasks WHERE status = 'blocked' ORDER BY blocked_at ASC LIMIT 1")
      .get() as { blocked_at?: string } | undefined;
    const blockedOverSla = this.scalarCount(
      `SELECT COUNT(*) FROM subtasks
       WHERE status = 'blocked'
         AND blocked_at IS NOT NULL
         AND blocked_at <= '${new Date(Date.now() - BLOCKED_SLA_MINUTES * 60_000).toISOString()}'`,
    );
    const manualTakeovers7d = this.countActivitySince("manual_takeover", sinceIso);
    const reviewTimeoutTakeovers7d = this.countActivitySince("review_timeout_takeover", sinceIso);
    const threadRebinds7d = this.countActivitySince("thread_rebound", sinceIso);
    const reworkRate =
      numberOrZero(reviews.total_reviews) > 0
        ? numberOrZero(reviews.rejected_reviews) / numberOrZero(reviews.total_reviews)
        : null;
    return {
      review_pending: numberOrZero(openSubtasks.review_pending),
      blocked: numberOrZero(openSubtasks.blocked),
      high_risk_open: numberOrZero(openSubtasks.high_risk_open),
      high_risk_review_pending: numberOrZero(openSubtasks.high_risk_review_pending),
      rework_rate: reworkRate,
      manual_takeovers_7d: manualTakeovers7d,
      review_timeout_takeovers_7d: reviewTimeoutTakeovers7d,
      thread_rebinds_7d: threadRebinds7d,
      blocked_over_sla: blockedOverSla,
      rejected_reviews: numberOrZero(reviews.rejected_reviews),
      total_reviews: numberOrZero(reviews.total_reviews),
      avg_review_score:
        typeof reviews.avg_review_score === "number" && Number.isFinite(reviews.avg_review_score)
          ? Number(reviews.avg_review_score)
          : null,
      avg_review_wait_minutes:
        typeof reviews.avg_review_wait_minutes === "number" &&
        Number.isFinite(reviews.avg_review_wait_minutes)
          ? Number(reviews.avg_review_wait_minutes)
          : null,
      avg_rework_count_open:
        typeof openSubtasks.avg_rework_count_open === "number" &&
        Number.isFinite(openSubtasks.avg_rework_count_open)
          ? Number(openSubtasks.avg_rework_count_open)
          : null,
      oldest_review_age_minutes: oldestReview?.review_requested_at
        ? Math.max(
            0,
            Math.floor((Date.now() - new Date(oldestReview.review_requested_at).getTime()) / 60_000),
          )
        : null,
      oldest_blocked_age_minutes: oldestBlocked?.blocked_at
        ? Math.max(0, Math.floor((Date.now() - new Date(oldestBlocked.blocked_at).getTime()) / 60_000))
        : null,
    };
  }

  stageGateSummary(): StageGateSummary {
    const metrics = this.governanceMetrics();
    const doneSubtasks = this.scalarCount("SELECT COUNT(*) FROM subtasks WHERE status = 'done'");
    const stage1: StageGateCheck[] = [
      {
        key: "completed_runs",
        label: "已完成闭环子任务",
        passed: doneSubtasks >= STAGE_1_MIN_DONE_SUBTASKS,
        value: String(doneSubtasks),
        target: `>= ${STAGE_1_MIN_DONE_SUBTASKS}`,
      },
      {
        key: "review_timeout_takeovers",
        label: "7 日评审超时接管",
        passed: metrics.review_timeout_takeovers_7d <= STAGE_1_MAX_REVIEW_TIMEOUT_TAKEOVERS,
        value: String(metrics.review_timeout_takeovers_7d),
        target: `<= ${STAGE_1_MAX_REVIEW_TIMEOUT_TAKEOVERS}`,
      },
      {
        key: "rework_rate",
        label: "返工比例",
        passed:
          metrics.rework_rate === null || metrics.rework_rate <= STAGE_1_MAX_REWORK_RATE,
        value: formatRatio(metrics.rework_rate),
        target: `<= ${Math.round(STAGE_1_MAX_REWORK_RATE * 100)}%`,
      },
    ];
    const stage2: StageGateCheck[] = [
      {
        key: "thread_rebinds",
        label: "7 日线程重绑",
        passed: metrics.thread_rebinds_7d <= STAGE_2_MAX_THREAD_REBINDS,
        value: String(metrics.thread_rebinds_7d),
        target: `<= ${STAGE_2_MAX_THREAD_REBINDS}`,
      },
      {
        key: "manual_takeovers",
        label: "7 日人工接管",
        passed: metrics.manual_takeovers_7d <= STAGE_2_MAX_MANUAL_TAKEOVERS,
        value: String(metrics.manual_takeovers_7d),
        target: `<= ${STAGE_2_MAX_MANUAL_TAKEOVERS}`,
      },
      {
        key: "avg_review_wait",
        label: "平均评审等待",
        passed:
          metrics.avg_review_wait_minutes === null ||
          metrics.avg_review_wait_minutes <= REVIEW_WAIT_SLA_MINUTES,
        value: formatMinutes(metrics.avg_review_wait_minutes),
        target: `<= ${REVIEW_WAIT_SLA_MINUTES} 分钟`,
      },
      {
        key: "blocked_sla",
        label: "阻塞超 SLA",
        passed: metrics.blocked_over_sla === 0,
        value: String(metrics.blocked_over_sla),
        target: `= 0（>${BLOCKED_SLA_MINUTES} 分钟）`,
      },
    ];
    return {
      stage_1_passed: stage1.every((item) => item.passed),
      stage_2_passed: stage2.every((item) => item.passed),
      stage_1: stage1,
      stage_2: stage2,
    };
  }

  listObservationSubtasks(filters: {
    limit?: number;
    currentRole?: string;
    highRisk?: boolean;
  } = {}): SubtaskRecord[] {
    const where = ["status IN ('assigned', 'in_progress', 'review', 'rework', 'blocked')"];
    const args: SqlArg[] = [];
    if (filters.currentRole) {
      where.push("current_role = ?");
      args.push(filters.currentRole);
    }
    if (typeof filters.highRisk === "boolean") {
      where.push("is_high_risk = ?");
      args.push(filters.highRisk ? 1 : 0);
    }
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 12;
    args.push(limit);
    return (
      this.db
        .prepare(
          `SELECT * FROM subtasks
           WHERE ${where.join(" AND ")}
           ORDER BY is_high_risk DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(...args) as Array<Record<string, unknown>>
    ).map((row) => this.mapSubtaskRow(row));
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_by_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        deliverable TEXT NOT NULL DEFAULT '',
        acceptance TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL,
        current_role TEXT,
        assigned_agent_id TEXT,
        current_session_key TEXT,
        is_high_risk INTEGER NOT NULL DEFAULT 0,
        risk_tags TEXT NOT NULL DEFAULT '',
        base_ref TEXT NOT NULL DEFAULT '',
        branch_ref TEXT NOT NULL DEFAULT '',
        latest_commit_ref TEXT NOT NULL DEFAULT '',
        change_summary TEXT NOT NULL DEFAULT '',
        test_summary TEXT NOT NULL DEFAULT '',
        delivery_summary TEXT NOT NULL DEFAULT '',
        risk_summary TEXT NOT NULL DEFAULT '',
        handoff_summary TEXT NOT NULL DEFAULT '',
        review_requested_at TEXT,
        blocked_at TEXT,
        blocked_by_agent_id TEXT,
        blocked_reason TEXT NOT NULL DEFAULT '',
        blocked_resolution TEXT NOT NULL DEFAULT '',
        rework_count INTEGER NOT NULL DEFAULT 0,
        created_by_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
        reviewer_agent_id TEXT NOT NULL,
        result TEXT NOT NULL,
        score INTEGER NOT NULL,
        wait_minutes INTEGER,
        issues TEXT NOT NULL DEFAULT '',
        comment TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        subtask_id TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        session_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);
      CREATE INDEX IF NOT EXISTS idx_subtasks_status ON subtasks(status);
      CREATE INDEX IF NOT EXISTS idx_subtasks_assigned ON subtasks(assigned_agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_reviews_subtask_id ON reviews(subtask_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_subtask_id ON activity_logs(subtask_id, created_at DESC);
    `);
    this.ensureSubtaskColumns();
  }

  private requireSubtask(subtaskId: string): SubtaskRecord {
    const subtask = this.getSubtask(subtaskId);
    if (!subtask) {
      throw new Error(`subtask not found: ${subtaskId}`);
    }
    return subtask;
  }

  private assertAssignedExecutor(subtask: SubtaskRecord, agentId: string): void {
    if (!agentId.trim()) {
      throw new Error("agent id is required");
    }
    if (!subtask.assigned_agent_id || subtask.assigned_agent_id !== agentId) {
      throw new Error(`subtask ${subtask.id} is not assigned to ${agentId}`);
    }
  }

  private updateSubtask(subtaskId: string, patch: Partial<SubtaskRecord>): void {
    const current = this.requireSubtask(subtaskId);
    const next: SubtaskRecord = {
      ...current,
      ...patch,
      is_high_risk: patch.is_high_risk ?? current.is_high_risk,
      risk_tags: patch.risk_tags ?? current.risk_tags,
      current_role:
        patch.current_role === undefined
          ? roleForSubtaskStatus((patch.status ?? current.status) as SubtaskStatus)
          : patch.current_role,
      updated_at: isoNow(),
    };
    this.db
      .prepare(
        `UPDATE subtasks
         SET task_id = ?, name = ?, description = ?, deliverable = ?, acceptance = ?, priority = ?,
             status = ?, current_role = ?, assigned_agent_id = ?, current_session_key = ?,
             is_high_risk = ?, risk_tags = ?, base_ref = ?, branch_ref = ?, latest_commit_ref = ?,
             change_summary = ?, test_summary = ?, delivery_summary = ?, risk_summary = ?,
             handoff_summary = ?, review_requested_at = ?, blocked_at = ?, blocked_by_agent_id = ?,
             blocked_reason = ?, blocked_resolution = ?, rework_count = ?, created_by_agent_id = ?,
             created_at = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        next.task_id,
        next.name,
        next.description,
        next.deliverable,
        next.acceptance,
        next.priority,
        next.status,
        next.current_role,
        next.assigned_agent_id,
        next.current_session_key,
        next.is_high_risk ? 1 : 0,
        next.risk_tags,
        next.base_ref,
        next.branch_ref,
        next.latest_commit_ref,
        next.change_summary,
        next.test_summary,
        next.delivery_summary,
        next.risk_summary,
        next.handoff_summary,
        next.review_requested_at,
        next.blocked_at,
        next.blocked_by_agent_id,
        next.blocked_reason,
        next.blocked_resolution,
        next.rework_count,
        next.created_by_agent_id,
        next.created_at,
        next.updated_at,
        next.completed_at,
        subtaskId,
      );
  }

  private ensureSubtaskColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const ensure = (name: string, sql: string) => {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE subtasks ADD COLUMN ${sql}`);
      }
    };
    ensure("is_high_risk", "is_high_risk INTEGER NOT NULL DEFAULT 0");
    ensure("risk_tags", "risk_tags TEXT NOT NULL DEFAULT ''");
    ensure("current_role", "current_role TEXT");
    ensure("base_ref", "base_ref TEXT NOT NULL DEFAULT ''");
    ensure("branch_ref", "branch_ref TEXT NOT NULL DEFAULT ''");
    ensure("latest_commit_ref", "latest_commit_ref TEXT NOT NULL DEFAULT ''");
    ensure("change_summary", "change_summary TEXT NOT NULL DEFAULT ''");
    ensure("test_summary", "test_summary TEXT NOT NULL DEFAULT ''");
    ensure("delivery_summary", "delivery_summary TEXT NOT NULL DEFAULT ''");
    ensure("risk_summary", "risk_summary TEXT NOT NULL DEFAULT ''");
    ensure("handoff_summary", "handoff_summary TEXT NOT NULL DEFAULT ''");
    ensure("review_requested_at", "review_requested_at TEXT");
    ensure("blocked_at", "blocked_at TEXT");
    ensure("blocked_by_agent_id", "blocked_by_agent_id TEXT");
    ensure("blocked_reason", "blocked_reason TEXT NOT NULL DEFAULT ''");
    ensure("blocked_resolution", "blocked_resolution TEXT NOT NULL DEFAULT ''");
    const reviewColumns = new Set(
      (this.db.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!reviewColumns.has("wait_minutes")) {
      this.db.exec("ALTER TABLE reviews ADD COLUMN wait_minutes INTEGER");
    }
    this.db.exec(`
      UPDATE subtasks
      SET current_role = CASE status
        WHEN 'pending' THEN 'planner'
        WHEN 'assigned' THEN 'executor'
        WHEN 'in_progress' THEN 'executor'
        WHEN 'review' THEN 'reviewer'
        WHEN 'rework' THEN 'executor'
        WHEN 'blocked' THEN 'patrol'
        WHEN 'done' THEN 'planner'
        WHEN 'cancelled' THEN 'planner'
        ELSE current_role
      END
      WHERE current_role IS NULL OR current_role = ''
    `);
  }

  private insertActivity(input: {
    agentId?: string;
    subtaskId?: string;
    action: string;
    summary: string;
    sessionKey?: string;
  }): ActivityLogRecord {
    const row = {
      id: randomUUID(),
      agent_id: input.agentId?.trim() || null,
      subtask_id: input.subtaskId?.trim() || null,
      action: input.action.trim(),
      summary: input.summary.trim(),
      session_key: input.sessionKey?.trim() || null,
      created_at: isoNow(),
    } satisfies ActivityLogRecord;
    this.db
      .prepare(
        `INSERT INTO activity_logs (
          id, agent_id, subtask_id, action, summary, session_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.agent_id,
        row.subtask_id,
        row.action,
        row.summary,
        row.session_key,
        row.created_at,
      );
    return row;
  }

  private touchTaskStatus(taskId: string, status: "planning" | "active"): void {
    const now = isoNow();
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'")
      .run(status, now, taskId);
  }

  private syncTaskStatus(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task || task.status === "cancelled") {
      return;
    }
    const counts = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
          SUM(CASE WHEN status IN ('pending', 'assigned', 'in_progress', 'review', 'rework', 'blocked') THEN 1 ELSE 0 END) AS open_count
         FROM subtasks
         WHERE task_id = ?`,
      )
      .get(taskId) as { total: number; done_count: number; open_count: number };
    const nextStatus =
      counts.total > 0 && counts.total === counts.done_count
        ? "completed"
        : counts.open_count > 0
          ? "active"
          : task.status;
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, isoNow(), taskId);
  }

  private listStaleSubtasks(status: SubtaskStatus, staleMinutes: number): SubtaskRecord[] {
    const threshold = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    return (
      this.db
        .prepare(
          "SELECT * FROM subtasks WHERE status = ? AND updated_at <= ? ORDER BY is_high_risk DESC, updated_at ASC LIMIT 25",
        )
        .all(status, threshold) as Array<Record<string, unknown>>
    ).map((row) => this.mapSubtaskRow(row));
  }

  private scalarCount(sql: string): number {
    const row = this.db.prepare(sql).get() as { "COUNT(*)": number } | undefined;
    return Number(row?.["COUNT(*)"] ?? 0);
  }

  private countActivitySince(action: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM activity_logs WHERE action = ? AND created_at >= ?",
      )
      .get(action, sinceIso) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private mapSubtaskRow(row: Record<string, unknown>): SubtaskRecord {
    return {
      ...(row as unknown as Omit<SubtaskRecord, "is_high_risk">),
      is_high_risk: Number(row.is_high_risk ?? 0) === 1,
    };
  }

  private sortSubtasksForGovernance(items: SubtaskRecord[]): SubtaskRecord[] {
    return [...items].sort((left, right) => {
      if (left.is_high_risk !== right.is_high_risk) {
        return Number(right.is_high_risk) - Number(left.is_high_risk);
      }
      return right.updated_at.localeCompare(left.updated_at);
    });
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function lookbackIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

function numberOrZero(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function formatRatio(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function formatMinutes(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)} 分钟`;
}

function deriveRiskSignals(params: {
  explicitHighRisk?: boolean;
  explicitRiskTags?: string;
  currentHighRisk?: boolean;
  currentRiskTags?: string;
  fields: Array<string | undefined>;
  priority?: string;
}): { isHighRisk: boolean; riskTags: string } {
  const explicitTags = normalizeRiskTags(params.explicitRiskTags);
  const inferredTags = inferRiskTags(params.fields);
  const includePriorityTag =
    normalizePriorityValue(params.priority) === "high" &&
    (params.explicitHighRisk === true ||
      params.currentHighRisk === true ||
      explicitTags.length > 0 ||
      inferredTags.length > 0);
  if (typeof params.explicitHighRisk === "boolean") {
    return {
      isHighRisk: params.explicitHighRisk,
      riskTags:
        params.explicitHighRisk
          ? mergeRiskTags(
              params.currentRiskTags,
              params.explicitRiskTags,
              inferredTags.join(","),
              includePriorityTag ? "high_priority" : undefined,
            ).join(",")
          : explicitTags.join(","),
    };
  }
  const mergedTags = mergeRiskTags(
    params.currentRiskTags,
    params.explicitRiskTags,
    inferredTags.join(","),
    includePriorityTag ? "high_priority" : undefined,
  );
  return {
    isHighRisk: params.currentHighRisk === true || mergedTags.length > 0,
    riskTags: mergedTags.join(","),
  };
}

function inferRiskTags(fields: Array<string | undefined>): string[] {
  const tags = new Set<string>();
  const text = fields
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n")
    .toLowerCase();
  if (/\bschema|migration|ddl|backfill|数据库|表结构\b/.test(text)) {
    tags.add("schema");
  }
  if (/\bauth|permission|rbac|oauth|token|login|权限|鉴权\b/.test(text)) {
    tags.add("auth");
  }
  if (/\brelease|deploy|rollout|production|上线|发布\b/.test(text)) {
    tags.add("release");
  }
  if (/\bthread|session|handoff|rebind|discord|线程|会话|交接\b/.test(text)) {
    tags.add("session");
  }
  if (/\bpayment|billing|invoice|checkout|付款|计费\b/.test(text)) {
    tags.add("billing");
  }
  if (/\bsecurity|secret|credential|密钥|凭证|安全\b/.test(text)) {
    tags.add("security");
  }
  return Array.from(tags);
}

function mergeRiskTags(...values: Array<string | undefined>): string[] {
  const tags = new Set<string>();
  for (const value of values) {
    for (const tag of normalizeRiskTags(value)) {
      tags.add(tag);
    }
  }
  return Array.from(tags);
}

function normalizeRiskTags(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n|]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePriorityValue(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function roleForSubtaskStatus(status: SubtaskStatus): WorkflowRole {
  switch (status) {
    case "pending":
    case "done":
    case "cancelled":
      return "planner";
    case "review":
      return "reviewer";
    case "blocked":
      return "patrol";
    case "assigned":
    case "in_progress":
    case "rework":
    default:
      return "executor";
  }
}
