import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import { createTestPluginApi } from "../../../test/helpers/extensions/plugin-api.js";
import { createMockServerResponse } from "../../../test/helpers/extensions/mock-http-response.js";
import plugin from "../index.js";
import { registerWorkflowCli } from "./cli.js";
import { createWorkflowCommand } from "./command.js";
import { getWorkflowStore, resetWorkflowStoreForTests } from "./db.js";
import { createWorkflowTool } from "./tool.js";

async function withWorkflowStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workflow-"));
  try {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      resetWorkflowStoreForTests();
      return await fn();
    });
  } finally {
    resetWorkflowStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  resetWorkflowStoreForTests();
});

function createWorkflowApi(params?: {
  pluginConfig?: Record<string, unknown>;
  registerCommand?: (command: Parameters<NonNullable<typeof createTestPluginApi>>[0]["registerCommand"]) => void;
}) {
  return createTestPluginApi({
    id: "workflow",
    name: "workflow",
    source: "test",
    config: {
      gateway: {
        port: 18789,
      },
    },
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      config: {
        loadConfig: () => ({
          gateway: {
            port: 18789,
          },
        }),
      },
    },
    registerCommand: params?.registerCommand as never,
  });
}

function requireText(result: { text?: unknown } | null | undefined): string {
  if (typeof result?.text !== "string") {
    throw new Error("workflow command did not return text");
  }
  return result.text;
}

describe("workflow store", () => {
  it("completes the basic planner -> executor -> reviewer lifecycle and summarizes queues", async () => {
    await withWorkflowStateDir(async () => {
      const store = getWorkflowStore({
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      });

      const task = store.createTask({
        name: "Ship workflow MVP",
        actor: { agentId: "pm" },
      });
      const subtask = store.createSubtask({
        taskId: task.id,
        name: "Implement plugin skeleton",
        assignedAgentId: "dev1",
        actor: { agentId: "pm" },
      });
      expect(subtask.current_role).toBe("executor");

      store.startSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        sessionKey: "agent:dev1:main",
      });
      store.handoffSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        baseRef: "origin/main",
        branchRef: "workflow/subtask-dev1",
        commitRef: "abc1234",
        testSummary: "vitest workflow.test.ts",
        handoffSummary: "state captured before review",
        riskSummary: "dashboard copy may still need polish",
      });
      store.submitSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        commitRef: "abc1234",
        changeSummary: "Added plugin skeleton and queue flow",
        testSummary: "vitest workflow.test.ts passed",
        deliverySummary: "Plugin skeleton is ready for review",
        riskSummary: "No browser smoke yet",
        baseRef: "origin/main",
        branchRef: "workflow/subtask-dev1",
      });
      const submitted = store.getSubtask(subtask.id);
      expect(submitted?.status).toBe("review");
      expect(submitted?.current_role).toBe("reviewer");
      expect(submitted?.latest_commit_ref).toBe("abc1234");
      expect(submitted?.handoff_summary).toBe("");
      const reviewed = store.reviewSubtask({
        subtaskId: subtask.id,
        reviewerAgentId: "qa",
        result: "approved",
        score: 4,
        comment: "acceptable",
      });

      expect(reviewed.subtask.status).toBe("done");
      expect(reviewed.subtask.current_role).toBe("planner");
      expect(store.getTask(task.id)?.status).toBe("completed");
      const reviews = store.listReviews({ subtaskId: subtask.id });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.wait_minutes).not.toBeNull();

      const summary = store.queueSummary();
      expect(summary.tasks.completed).toBe(1);
      expect(summary.subtasks.done).toBe(1);
      expect(summary.subtasks.review).toBe(0);
      expect(store.listActivity({ limit: 20 })).toHaveLength(6);
      const metrics = store.governanceMetrics();
      expect(metrics.total_reviews).toBe(1);
      expect(metrics.avg_review_wait_minutes).not.toBeNull();
    });
  });

  it("moves rejected work into rework and supports planner cancellation", async () => {
    await withWorkflowStateDir(async () => {
      const store = getWorkflowStore({
        roles: { planner: ["pm"], reviewer: ["qa"] },
      });

      const task = store.createTask({
        name: "Handle review loop",
        actor: { agentId: "pm" },
      });
      const subtask = store.createSubtask({
        taskId: task.id,
        name: "Write revision",
        assignedAgentId: "dev1",
        actor: { agentId: "pm" },
      });

      store.startSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        sessionKey: "agent:dev1:main",
      });
      store.submitSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        commitRef: "def5678",
        changeSummary: "Initial revision",
        testSummary: "tests missing",
        deliverySummary: "Revision draft ready",
      });
      const rejected = store.reviewSubtask({
        subtaskId: subtask.id,
        reviewerAgentId: "qa",
        result: "rejected",
        score: 2,
        issues: "missing tests",
      });
      expect(rejected.subtask.status).toBe("rework");
      expect(rejected.subtask.rework_count).toBe(1);
      expect(rejected.subtask.current_role).toBe("executor");

      store.blockSubtask({
        subtaskId: subtask.id,
        agentId: "ops",
        summary: "waiting on dependency",
      });
      const blocked = store.getSubtask(subtask.id);
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.blocked_reason).toContain("waiting on dependency");
      expect(blocked?.blocked_by_agent_id).toBe("ops");

      const unblocked = store.unblockSubtask({
        subtaskId: subtask.id,
        agentId: "ops",
        resolution: "dependency resolved",
        assignedAgentId: "dev1",
      });
      expect(unblocked.status).toBe("assigned");
      expect(unblocked.blocked_resolution).toContain("dependency resolved");
      expect(unblocked.blocked_at).toBeNull();
      expect(unblocked.current_role).toBe("executor");

      const cancelled = store.cancelSubtask({
        subtaskId: subtask.id,
        agentId: "pm",
        summary: "scope changed",
      });
      expect(cancelled.status).toBe("cancelled");
      expect(store.getTask(task.id)?.status).toBe("active");

      const summary = store.queueSummary();
      expect(summary.subtasks.rework).toBe(0);
      expect(summary.subtasks.cancelled).toBe(1);
      expect(store.listActivity({ limit: 20 }).map((entry) => entry.action)).toContain(
        "subtask_cancelled",
      );
    });
  });

  it("tracks high-risk subtasks across filters and governance observations", async () => {
    await withWorkflowStateDir(async () => {
      const store = getWorkflowStore({
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      });

      const task = store.createTask({
        name: "High-risk rollout",
        actor: { agentId: "pm" },
      });
      const subtask = store.createSubtask({
        taskId: task.id,
        name: "Apply schema migration",
        assignedAgentId: "dev-risk",
        isHighRisk: true,
        riskTags: "schema,migration",
        actor: { agentId: "pm" },
      });
      expect(subtask.is_high_risk).toBe(true);
      expect(subtask.risk_tags).toContain("schema");
      expect(subtask.risk_tags).toContain("migration");

      store.startSubtask({
        subtaskId: subtask.id,
        agentId: "dev-risk",
        sessionKey: "agent:dev-risk:main",
      });
      store.submitSubtask({
        subtaskId: subtask.id,
        agentId: "dev-risk",
        commitRef: "risk1234",
        changeSummary: "Added migration and backfill path",
        testSummary: "migration tests passed",
        deliverySummary: "Ready for guarded review",
        riskSummary: "requires staged rollout",
        riskTags: "schema,migration,release",
        isHighRisk: true,
        baseRef: "origin/main",
        branchRef: "workflow/high-risk-dev",
      });

      const reviewItems = store.listSubtasks({
        currentRole: "reviewer",
        highRisk: true,
      });
      expect(reviewItems).toHaveLength(1);
      expect(reviewItems[0]?.id).toBe(subtask.id);
      expect(reviewItems[0]?.risk_tags).toBe("schema,migration,release");

      const observations = store.listObservationSubtasks({
        highRisk: true,
        currentRole: "reviewer",
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.latest_commit_ref).toBe("risk1234");

      const metrics = store.governanceMetrics();
      expect(metrics.high_risk_open).toBe(1);
      expect(metrics.high_risk_review_pending).toBe(1);
    });
  });

  it("infers high-risk signals from subtask content when flags are omitted", async () => {
    await withWorkflowStateDir(async () => {
      const store = getWorkflowStore({
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      });

      const task = store.createTask({
        name: "Database release",
        actor: { agentId: "pm" },
      });
      const inferred = store.createSubtask({
        taskId: task.id,
        name: "Run schema migration rollout",
        description: "Update auth token tables before release",
        priority: "high",
        assignedAgentId: "dev1",
        actor: { agentId: "pm" },
      });

      expect(inferred.is_high_risk).toBe(true);
      expect(inferred.risk_tags).toContain("schema");
      expect(inferred.risk_tags).toContain("auth");
      expect(inferred.risk_tags).toContain("release");
      expect(inferred.risk_tags).toContain("high_priority");

      store.startSubtask({
        subtaskId: inferred.id,
        agentId: "dev1",
        sessionKey: "agent:dev1:risk",
      });
      const submitted = store.submitSubtask({
        subtaskId: inferred.id,
        agentId: "dev1",
        commitRef: "risk-auto-1",
        changeSummary: "Complete schema migration for production rollout",
        testSummary: "migration validation passed",
        deliverySummary: "ready for guarded release",
      });

      expect(submitted.is_high_risk).toBe(true);
      expect(submitted.risk_tags).toContain("schema");
      expect(submitted.risk_tags).toContain("release");
    });
  });

  it("quantifies stage gates from reviews, interventions, and blocked SLA", async () => {
    await withWorkflowStateDir(async () => {
      const store = getWorkflowStore({
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      });

      for (const name of ["A", "B", "C"]) {
        const task = store.createTask({
          name: `Stage gate ${name}`,
          actor: { agentId: "pm" },
        });
        const subtask = store.createSubtask({
          taskId: task.id,
          name: `Close ${name}`,
          assignedAgentId: "dev1",
          actor: { agentId: "pm" },
        });
        store.startSubtask({
          subtaskId: subtask.id,
          agentId: "dev1",
          sessionKey: `agent:dev1:${name}`,
        });
        store.submitSubtask({
          subtaskId: subtask.id,
          agentId: "dev1",
          commitRef: `commit-${name}`,
          changeSummary: `change ${name}`,
          testSummary: `test ${name}`,
          deliverySummary: `delivery ${name}`,
        });
        store.reviewSubtask({
          subtaskId: subtask.id,
          reviewerAgentId: "qa",
          result: "approved",
          score: 4,
        });
      }

      store.createActivity({
        agentId: "ops",
        action: "thread_rebound",
        summary: "rebound one discord thread",
      });
      store.createActivity({
        agentId: "pm",
        action: "manual_takeover",
        summary: "planner manually unwedged a stalled run",
      });

      const metrics = store.governanceMetrics();
      expect(metrics.thread_rebinds_7d).toBe(1);
      expect(metrics.manual_takeovers_7d).toBe(1);
      expect(metrics.rework_rate).toBe(0);

      const stageGates = store.stageGateSummary();
      expect(stageGates.stage_1_passed).toBe(true);
      expect(stageGates.stage_2_passed).toBe(true);
      expect(stageGates.stage_1.find((item) => item.key === "completed_runs")?.value).toBe("3");
      expect(stageGates.stage_2.find((item) => item.key === "thread_rebinds")?.value).toBe("1");
    });
  });
});

describe("workflow command", () => {
  it("registers a Chinese /workflow command entry with Discord usage guidance", async () => {
    let registered: { name?: string; handler?: (ctx: Record<string, unknown>) => unknown } | undefined;

    plugin.register(
      createWorkflowApi({
        pluginConfig: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
        registerCommand: (command) => {
          registered = command as unknown as typeof registered;
        },
      }) as never,
    );

    expect(registered?.name).toBe("workflow");

    const text = requireText(
      await registered?.handler?.({
        channel: "discord",
        isAuthorizedSender: true,
        commandBody: "/workflow",
        config: {},
        messageThreadId: "thread-1",
        requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      }),
    );

    expect(text).toContain("Workflow 协作入口");
    expect(text).toContain("http://127.0.0.1:18789/plugins/workflow/");
    expect(text).toContain("/workflow planner");
    expect(text).toContain("/focus main");
    expect(text).toContain("说明：当前已支持 planner / executor / reviewer / patrol 的最小写命令");
  });

  it("returns queue and review summaries from the workflow store", async () => {
    await withWorkflowStateDir(async () => {
      const api = createWorkflowApi({
        pluginConfig: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
      });
      const store = getWorkflowStore(api.pluginConfig);
      const task = store.createTask({
        name: "Ship Discord workflow",
        actor: { agentId: "main" },
      });
      const subtask = store.createSubtask({
        taskId: task.id,
        name: "Review PR for plugin command",
        assignedAgentId: "dev1",
        isHighRisk: true,
        actor: { agentId: "main" },
      });
      store.startSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        sessionKey: "agent:dev1:main",
      });
      store.submitSubtask({
        subtaskId: subtask.id,
        agentId: "dev1",
        commitRef: "abc1234",
        changeSummary: "Added workflow plugin command",
        testSummary: "workflow tests passed",
        deliverySummary: "Ready for QA",
        riskSummary: "Discord rollout pending",
        isHighRisk: true,
      });

      const command = createWorkflowCommand({
        api: api as never,
      });

      const queueText = requireText(
        await command.handler({
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: "/workflow queue",
          args: "queue",
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(queueText).toContain("Workflow 队列概览");
      expect(queueText).toContain("review=1");
      expect(queueText).toContain("high_risk_review_pending=1");

      const reviewText = requireText(
        await command.handler({
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: "/workflow review",
          args: "review",
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(reviewText).toContain("待评审子任务");
      expect(reviewText).toContain("Review PR for plugin command");
      expect(reviewText).toContain("high-risk");
    });
  });

  it("supports create-task, plan-subtasks, and cancel-subtask from a planner-bound command context", async () => {
    await withWorkflowStateDir(async () => {
      const api = createWorkflowApi({
        pluginConfig: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
      });
      const command = createWorkflowCommand({
        api: api as never,
      });

      const createText = requireText(
        await command.handler({
          agentId: "main",
          sessionKey: "agent:main:discord:thread-1",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: '/workflow create-task "Ship plugin command"',
          args: 'create-task "Ship plugin command" --description "wire discord entry"',
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(createText).toContain("任务已创建");
      expect(createText).toContain("下一步：/workflow plan-subtasks");

      const store = getWorkflowStore(api.pluginConfig);
      const task = store.listTasks({ limit: 1 })[0];
      expect(task?.name).toBe("Ship plugin command");

      const planText = requireText(
        await command.handler({
          agentId: "main",
          sessionKey: "agent:main:discord:thread-1",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow plan-subtasks ${task?.id} --persist`,
          args: `plan-subtasks ${task?.id} --plan "接入插件命令 | owner: dev1 ; 补验证 | owner: qa" --persist`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(planText).toContain("子任务已生成并落库");
      expect(planText).toContain("接入插件命令");
      expect(planText).toContain("补验证");

      const subtasks = store.listSubtasks({ taskId: task?.id, limit: 10 });
      expect(subtasks).toHaveLength(2);
      expect(subtasks[0]?.assigned_agent_id).toBeTruthy();

      const cancelText = requireText(
        await command.handler({
          agentId: "main",
          sessionKey: "agent:main:discord:thread-1",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow cancel-subtask ${subtasks[0]?.id}`,
          args: `cancel-subtask ${subtasks[0]?.id} --summary "scope changed"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(cancelText).toContain("子任务已取消");
      expect(store.getSubtask(subtasks[0]!.id)?.status).toBe("cancelled");
    });
  });

  it("supports planner, reviewer, and patrol write commands", async () => {
    await withWorkflowStateDir(async () => {
      const api = createWorkflowApi({
        pluginConfig: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
      });
      const command = createWorkflowCommand({
        api: api as never,
      });
      const store = getWorkflowStore(api.pluginConfig);
      const task = store.createTask({
        name: "Govern command flow",
        actor: { agentId: "main" },
      });

      const createSubtaskText = requireText(
        await command.handler({
          agentId: "main",
          sessionKey: "agent:main:discord:planner-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow create-subtask ${task.id} "Prepare review package"`,
          args: `create-subtask ${task.id} "Prepare review package" --assigned dev1 --priority high --high-risk`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(createSubtaskText).toContain("子任务已创建");
      const created = store.listSubtasks({ taskId: task.id, limit: 1 })[0];
      expect(created?.assigned_agent_id).toBe("dev1");
      expect(created?.is_high_risk).toBe(true);

      const blockText = requireText(
        await command.handler({
          agentId: "ops",
          sessionKey: "agent:ops:discord:ops-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow block-subtask ${created?.id}`,
          args: `block-subtask ${created?.id} --summary "waiting on review environment"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(blockText).toContain("子任务已阻塞");
      expect(store.getSubtask(created!.id)?.status).toBe("blocked");

      const unblockText = requireText(
        await command.handler({
          agentId: "ops",
          sessionKey: "agent:ops:discord:ops-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow unblock-subtask ${created?.id}`,
          args: `unblock-subtask ${created?.id} --resolution "env restored" --assigned dev1`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(unblockText).toContain("子任务已解除阻塞");
      expect(store.getSubtask(created!.id)?.status).toBe("assigned");

      store.startSubtask({
        subtaskId: created!.id,
        agentId: "dev1",
        sessionKey: "agent:dev1:discord:dev-thread",
      });
      store.submitSubtask({
        subtaskId: created!.id,
        agentId: "dev1",
        commitRef: "abc-review-1",
        changeSummary: "Prepared review package",
        testSummary: "workflow tests passed",
        deliverySummary: "Ready for QA",
      });

      const reviewText = requireText(
        await command.handler({
          agentId: "qa",
          sessionKey: "agent:qa:discord:review-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow review-subtask ${created?.id}`,
          args: `review-subtask ${created?.id} --result approved --score 5 --comment "OK to merge"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(reviewText).toContain("评审已记录");
      expect(reviewText).toContain("result: approved");
      expect(store.getSubtask(created!.id)?.status).toBe("done");
    });
  });

  it("supports executor write commands from a focused executor context", async () => {
    await withWorkflowStateDir(async () => {
      const api = createWorkflowApi({
        pluginConfig: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
      });
      const command = createWorkflowCommand({
        api: api as never,
      });
      const store = getWorkflowStore(api.pluginConfig);
      const task = store.createTask({
        name: "Executor command flow",
        actor: { agentId: "main" },
      });
      const pending = store.createSubtask({
        taskId: task.id,
        name: "Claim me",
        actor: { agentId: "main" },
      });
      const assigned = store.createSubtask({
        taskId: task.id,
        name: "Ship me",
        assignedAgentId: "dev1",
        actor: { agentId: "main" },
      });

      const claimText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow claim-subtask ${pending.id}`,
          args: `claim-subtask ${pending.id}`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(claimText).toContain("子任务已认领");
      expect(store.getSubtask(pending.id)?.assigned_agent_id).toBe("dev1");

      const startText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow start-subtask ${assigned.id}`,
          args: `start-subtask ${assigned.id}`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(startText).toContain("子任务已开始执行");
      expect(store.getSubtask(assigned.id)?.status).toBe("in_progress");

      const handoffText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow handoff-subtask ${assigned.id}`,
          args: `handoff-subtask ${assigned.id} --handoff "state captured before review" --commit abc1234 --test "vitest passed"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(handoffText).toContain("交接信息已记录");
      expect(store.getSubtask(assigned.id)?.handoff_summary).toContain("state captured");

      const failedSubmitText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow submit-subtask ${assigned.id}`,
          args: `submit-subtask ${assigned.id} --commit abc1234 --change "workflow command shipped"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(failedSubmitText).toContain("提交失败");
      expect(failedSubmitText).toContain("deliverySummary");

      const submitText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow submit-subtask ${assigned.id}`,
          args: `submit-subtask ${assigned.id} --commit abc1234 --test "vitest passed" --delivery "ready for QA" --change "workflow command shipped"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(submitText).toContain("子任务已提交评审");
      expect(store.getSubtask(assigned.id)?.status).toBe("review");
    });
  });

  it("supports alias commands for plan, submit, approve, and block", async () => {
    await withWorkflowStateDir(async () => {
      const api = createWorkflowApi({
        pluginConfig: {
          roles: {
            planner: ["main"],
            reviewer: ["qa"],
            patrol: ["ops"],
          },
        },
      });
      const command = createWorkflowCommand({
        api: api as never,
      });
      const store = getWorkflowStore(api.pluginConfig);

      const task = store.createTask({
        name: "Alias flow",
        actor: { agentId: "main" },
      });

      const planText = requireText(
        await command.handler({
          agentId: "main",
          sessionKey: "agent:main:discord:planner-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow plan ${task.id}`,
          args: `plan ${task.id} --plan "实现别名 | owner: dev1" --persist`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(planText).toContain("子任务已生成并落库");
      const subtask = store.listSubtasks({ taskId: task.id, limit: 1 })[0];

      const claimText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow claim ${subtask?.id}`,
          args: `claim ${subtask?.id}`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(claimText).toContain("子任务已认领");

      const startText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow start ${subtask?.id}`,
          args: `start ${subtask?.id}`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(startText).toContain("子任务已开始执行");

      const submitText = requireText(
        await command.handler({
          agentId: "dev1",
          sessionKey: "agent:dev1:discord:dev-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow submit ${subtask?.id}`,
          args: `submit ${subtask?.id} --commit abc1234 --test "vitest passed" --delivery "ready for QA"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(submitText).toContain("子任务已提交评审");

      const approveText = requireText(
        await command.handler({
          agentId: "qa",
          sessionKey: "agent:qa:discord:review-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow approve ${subtask?.id}`,
          args: `approve ${subtask?.id} --score 5 --comment "approved via alias"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(approveText).toContain("评审已记录");
      expect(store.getSubtask(subtask!.id)?.status).toBe("done");

      const blockedTask = store.createSubtask({
        taskId: task.id,
        name: "Block alias",
        assignedAgentId: "dev1",
        actor: { agentId: "main" },
      });

      const blockText = requireText(
        await command.handler({
          agentId: "ops",
          sessionKey: "agent:ops:discord:ops-thread",
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: `/workflow block ${blockedTask.id}`,
          args: `block ${blockedTask.id} --summary "blocked via alias"`,
          config: {},
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      );
      expect(blockText).toContain("子任务已阻塞");
      expect(store.getSubtask(blockedTask.id)?.status).toBe("blocked");
    });
  });
});

describe("workflow tool", () => {
  it("exposes queue_summary, supports planner decomposition, and enforces planner-only cancellation", async () => {
    await withWorkflowStateDir(async () => {
      const pluginConfig = {
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      };
      const api = createTestPluginApi({
        id: "workflow",
        name: "Workflow",
        source: "test",
        config: {},
        runtime: {} as never,
        pluginConfig,
      });

      const store = getWorkflowStore(pluginConfig);
      const task = store.createTask({
        name: "Tool surface",
        actor: { agentId: "pm" },
      });
      const subtask = store.createSubtask({
        taskId: task.id,
        name: "Cancelable work",
        assignedAgentId: "dev1",
        actor: { agentId: "pm" },
      });

      const plannerTool = createWorkflowTool({
        api,
        context: { agentId: "pm", sessionKey: "agent:pm:main" },
      });
      const summaryResult = await plannerTool.execute("tool-1", {
        action: "queue_summary",
      });
      const parsedSummary = JSON.parse(String(summaryResult.content[0]?.text));
      expect(parsedSummary.result.subtasks.assigned).toBe(1);

      const stageGateResult = await plannerTool.execute("tool-stage-gates", {
        action: "stage_gates",
      });
      const parsedStageGates = JSON.parse(String(stageGateResult.content[0]?.text));
      expect(parsedStageGates.result.stage_1).toBeInstanceOf(Array);
      expect(parsedStageGates.result.stage_2).toBeInstanceOf(Array);

      const planningTask = store.createTask({
        name: "Planner decomposition",
        actor: { agentId: "pm" },
      });
      const planResult = await plannerTool.execute("tool-plan", {
        action: "plan_subtasks",
        taskId: planningTask.id,
        assignedAgentId: "dev2",
        persist: true,
        plan: [
          "- Design the dashboard | deliverable: HTML board | acceptance: root route renders in browser | priority: high",
          "- Wire planner helper | deliverable: plan_subtasks tool action | acceptance: planner can create drafts from a bullet plan",
        ].join("\n"),
      });
      const parsedPlan = JSON.parse(String(planResult.content[0]?.text));
      expect(parsedPlan.result.persisted).toBe(true);
      expect(parsedPlan.result.created).toHaveLength(2);
      expect(parsedPlan.result.created[0].assigned_agent_id).toBe("dev2");
      expect(parsedPlan.result.created[0].is_high_risk).toBe(false);
      expect(store.listSubtasks({ taskId: planningTask.id })).toHaveLength(2);

      const riskyPlanningTask = store.createTask({
        name: "Risky planner decomposition",
        actor: { agentId: "pm" },
      });
      const riskyPlanResult = await plannerTool.execute("tool-risk-plan", {
        action: "plan_subtasks",
        taskId: riskyPlanningTask.id,
        persist: true,
        plan: "- Prepare schema migration rollout | deliverable: SQL + rollout notes | acceptance: production rollout is reviewable | priority: high",
      });
      const riskyPlanPayload = JSON.parse(String(riskyPlanResult.content[0]?.text));
      expect(riskyPlanPayload.result.created).toHaveLength(1);
      expect(riskyPlanPayload.result.created[0].is_high_risk).toBe(true);
      expect(riskyPlanPayload.result.created[0].risk_tags).toContain("schema");

      const cancelResult = await plannerTool.execute("tool-2", {
        action: "cancel_subtask",
        subtaskId: subtask.id,
        summary: "deprioritized",
      });
      const parsedCancel = JSON.parse(String(cancelResult.content[0]?.text));
      expect(parsedCancel.result.status).toBe("cancelled");

      const executorTool = createWorkflowTool({
        api,
        context: { agentId: "dev1", sessionKey: "agent:dev1:main" },
      });
      const workTask = store.createTask({
        name: "Executor evidence",
        actor: { agentId: "pm" },
      });
      const evidenceSubtask = store.createSubtask({
        taskId: workTask.id,
        name: "Ship evidence",
        assignedAgentId: "dev1",
        actor: { agentId: "pm" },
      });
      await executorTool.execute("tool-claim", {
        action: "start_subtask",
        subtaskId: evidenceSubtask.id,
      });
      await executorTool.execute("tool-handoff", {
        action: "handoff_subtask",
        subtaskId: evidenceSubtask.id,
        baseRef: "origin/main",
        branchRef: "workflow/evidence-dev1",
        commitRef: "feedbee",
        testSummary: "pnpm test",
        handoffSummary: "ready if session changes",
      });
      const submitResult = await executorTool.execute("tool-submit", {
        action: "submit_subtask",
        subtaskId: evidenceSubtask.id,
        commitRef: "feedbee",
        changeSummary: "Added evidence plumbing",
        testSummary: "pnpm test passed",
        deliverySummary: "Ready for QA",
        isHighRisk: true,
        riskTags: "release",
      });
      const parsedSubmit = JSON.parse(String(submitResult.content[0]?.text));
      expect(parsedSubmit.result.status).toBe("review");
      expect(parsedSubmit.result.current_role).toBe("reviewer");

      const filteredResult = await plannerTool.execute("tool-risk-list", {
        action: "list_subtasks",
        currentRole: "reviewer",
        highRisk: true,
      });
      const filteredPayload = JSON.parse(String(filteredResult.content[0]?.text));
      expect(filteredPayload.result).toHaveLength(1);
      expect(filteredPayload.result[0].id).toBe(evidenceSubtask.id);
      expect(filteredPayload.result[0].is_high_risk).toBe(true);

      await expect(
        executorTool.execute("tool-3", {
          action: "cancel_subtask",
          subtaskId: subtask.id,
        }),
      ).rejects.toThrow(/requires role=planner/i);
    });
  });
});

describe("workflow plugin registration", () => {
  it("registers tool, cli, http route, and prompt guidance, and serves queue-summary plus dashboard html", async () => {
    await withWorkflowStateDir(async () => {
      const registerTool = vi.fn();
      const registerCli = vi.fn();
      const registerHttpRoute = vi.fn();
      const on = vi.fn();
      const pluginConfig = {
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      };

      plugin.register?.(
        createTestPluginApi({
          id: "workflow",
          name: "Workflow",
          source: "test",
          config: {},
          runtime: {} as never,
          pluginConfig,
          registerTool,
          registerCli,
          registerHttpRoute,
          on,
        }),
      );

      expect(registerTool).toHaveBeenCalledTimes(1);
      expect(registerCli).toHaveBeenCalledTimes(1);
      expect(registerHttpRoute).toHaveBeenCalledTimes(1);
      expect(registerHttpRoute.mock.calls[0]?.[0]).toMatchObject({
        path: "/plugins/workflow",
        auth: "gateway",
        match: "prefix",
      });
      expect(on).toHaveBeenCalledTimes(1);
      expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");

      const beforePromptBuild = on.mock.calls[0]?.[1];
      const guidance = await beforePromptBuild?.({}, { agentId: "pm" });
      expect(guidance?.prependSystemContext).toContain("role=planner");
      expect(guidance?.prependSystemContext).toContain("queue_summary");
      expect(guidance?.prependSystemContext).toContain("plan_subtasks");
      expect(guidance?.prependSystemContext).toContain("stage_gates");
      expect(guidance?.prependSystemContext).toContain("thread_rebound");

      const store = getWorkflowStore(pluginConfig);
      const task = store.createTask({
        name: "HTTP queue summary",
        actor: { agentId: "pm" },
      });
      const httpSubtask = store.createSubtask({
        taskId: task.id,
        name: "Pending task",
        assignedAgentId: "dev1",
        isHighRisk: true,
        riskTags: "schema",
        actor: { agentId: "pm" },
      });
      store.startSubtask({
        subtaskId: httpSubtask.id,
        agentId: "dev1",
        sessionKey: "agent:dev1:main",
      });

      const handler = registerHttpRoute.mock.calls[0]?.[0]?.handler as (
        req: IncomingMessage,
        res: ReturnType<typeof createMockServerResponse>,
      ) => Promise<boolean>;
      const res = createMockServerResponse();
      const handled = await handler(
        {
          method: "GET",
          url: "/plugins/workflow/queue-summary",
        } as IncomingMessage,
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(String(res.body));
      expect(payload.item.tasks.active).toBe(1);
      expect(payload.item.subtasks.in_progress).toBe(1);

      const stageGateRes = createMockServerResponse();
      const handledStageGates = await handler(
        {
          method: "GET",
          url: "/plugins/workflow/stage-gates",
        } as IncomingMessage,
        stageGateRes,
      );
      expect(handledStageGates).toBe(true);
      expect(stageGateRes.statusCode).toBe(200);
      const stageGatePayload = JSON.parse(String(stageGateRes.body));
      expect(stageGatePayload.item.stage_1).toBeInstanceOf(Array);
      expect(stageGatePayload.item.stage_2).toBeInstanceOf(Array);

      const planRes = createMockServerResponse();
      const handledPlan = await handler(
        Object.assign(new ReadableFromString(
          JSON.stringify({
            actor_agent_id: "pm",
            assigned_agent_id: "dev2",
            persist: true,
            plan: "- Ship dashboard | deliverable: HTML board | acceptance: browser root renders",
          }),
        ), {
          method: "POST",
          url: `/plugins/workflow/tasks/${task.id}/plan-subtasks`,
          headers: { "content-type": "application/json" },
        }) as IncomingMessage,
        planRes,
      );
      expect(handledPlan).toBe(true);
      expect(planRes.statusCode).toBe(201);
      const plannedPayload = JSON.parse(String(planRes.body));
      expect(plannedPayload.item.persisted).toBe(true);
      expect(plannedPayload.item.created).toHaveLength(1);
      expect(plannedPayload.item.created[0].assigned_agent_id).toBe("dev2");

      const htmlRes = createMockServerResponse();
      const handledHtml = await handler(
        {
          method: "GET",
          url: "/plugins/workflow/?subtaskStatus=review&currentRole=reviewer&highRisk=true&observationRole=reviewer&observationHighRisk=true",
          headers: { accept: "text/html" },
        } as IncomingMessage,
        htmlRes,
      );
      expect(handledHtml).toBe(true);
      expect(htmlRes.statusCode).toBe(200);
      expect(String(htmlRes.getHeader("content-type"))).toContain("text/html");
      expect(String(htmlRes.body)).toContain("<!DOCTYPE html>");
      expect(String(htmlRes.body)).toContain("工作流看板");
      expect(String(htmlRes.body)).toContain("治理观察");
      expect(String(htmlRes.body)).toContain("阶段门槛");
      expect(String(htmlRes.body)).toContain("QA 观察");
      expect(String(htmlRes.body)).toContain("Ops 观察");
      expect(String(htmlRes.body)).toContain("高风险观察");
      expect(String(htmlRes.body)).toContain("高风险");
      expect(String(htmlRes.body)).toContain("提交评审包");
      expect(String(htmlRes.body)).toContain("记录治理动作");
      expect(String(htmlRes.body)).toContain('name="subtaskStatus"');
      expect(String(htmlRes.body)).toContain('option value="review" selected');
      expect(String(htmlRes.body)).toContain('option value="reviewer" selected');
      expect(String(htmlRes.body)).toContain('option value="true" selected');
      expect(String(htmlRes.body)).toContain('href="/plugins/workflow/?subtaskStatus=blocked&amp;currentRole=reviewer&amp;highRisk=true&amp;observationRole=patrol&amp;observationHighRisk=true#ops-panel"');
      expect(String(htmlRes.body)).toContain('href="/plugins/workflow/?subtaskStatus=review&amp;currentRole=reviewer&amp;highRisk=true&amp;observationRole=reviewer&amp;observationHighRisk=true#qa-panel"');
      expect(String(htmlRes.body)).toContain('href="/plugins/workflow/?subtaskStatus=done&amp;currentRole=reviewer&amp;highRisk=true&amp;observationRole=reviewer&amp;observationHighRisk=true#subtasks-panel"');

      const submitRes = createMockServerResponse();
      const handledSubmit = await handler(
        Object.assign(new ReadableFromString(
          JSON.stringify({
            actor_agent_id: "dev1",
            commit_ref: "123abcd",
            change_summary: "HTTP schema migration path for production rollout",
            test_summary: "vitest passed",
            delivery_summary: "Ready for QA",
          }),
        ), {
          method: "POST",
          url: `/plugins/workflow/subtasks/${httpSubtask.id}/submit`,
          headers: { "content-type": "application/json" },
        }) as IncomingMessage,
        submitRes,
      );
      expect(handledSubmit).toBe(true);
      expect(submitRes.statusCode).toBe(200);
      const submitPayload = JSON.parse(String(submitRes.body));
      expect(submitPayload.item.status).toBe("review");
      expect(submitPayload.item.current_role).toBe("reviewer");

      const observationRes = createMockServerResponse();
      const handledObservation = await handler(
        {
          method: "GET",
          url: "/plugins/workflow/observations?highRisk=true&currentRole=reviewer",
        } as IncomingMessage,
        observationRes,
      );
      expect(handledObservation).toBe(true);
      expect(observationRes.statusCode).toBe(200);
      const observationPayload = JSON.parse(String(observationRes.body));
      expect(observationPayload.metrics.review_pending).toBe(1);
      expect(observationPayload.metrics.high_risk_open).toBe(1);
      expect(observationPayload.metrics.high_risk_review_pending).toBe(1);
      expect(observationPayload.items).toHaveLength(1);
      expect(observationPayload.items[0].is_high_risk).toBe(true);
      expect(observationPayload.items[0].risk_tags).toContain("schema");
      expect(observationPayload.items[0].risk_tags).toContain("release");
      expect(observationPayload.items[0].latest_commit_ref).toBe("123abcd");
      expect(observationPayload.metrics.avg_review_wait_minutes).toBeNull();

      const activityCreateRes = createMockServerResponse();
      const handledActivityCreate = await handler(
        Object.assign(new ReadableFromString(
          JSON.stringify({
            actor_agent_id: "ops",
            subtask_id: httpSubtask.id,
            action: "thread_rebound",
            summary: "discord thread rebound after manual repair",
          }),
        ), {
          method: "POST",
          url: "/plugins/workflow/activity",
          headers: { "content-type": "application/json" },
        }) as IncomingMessage,
        activityCreateRes,
      );
      expect(handledActivityCreate).toBe(true);
      expect(activityCreateRes.statusCode).toBe(201);
      const createdActivityPayload = JSON.parse(String(activityCreateRes.body));
      expect(createdActivityPayload.item.action).toBe("thread_rebound");
      expect(createdActivityPayload.item.subtask_id).toBe(httpSubtask.id);

      const activityListRes = createMockServerResponse();
      const handledActivityList = await handler(
        {
          method: "GET",
          url: "/plugins/workflow/activity?action=thread_rebound",
        } as IncomingMessage,
        activityListRes,
      );
      expect(handledActivityList).toBe(true);
      expect(activityListRes.statusCode).toBe(200);
      const activityListPayload = JSON.parse(String(activityListRes.body));
      expect(activityListPayload.items).toHaveLength(1);
      expect(activityListPayload.items[0].summary).toContain("manual repair");

      const stageGateAfterActivityRes = createMockServerResponse();
      const handledStageGateAfterActivity = await handler(
        {
          method: "GET",
          url: "/plugins/workflow/stage-gates",
        } as IncomingMessage,
        stageGateAfterActivityRes,
      );
      expect(handledStageGateAfterActivity).toBe(true);
      const stageGateAfterActivityPayload = JSON.parse(String(stageGateAfterActivityRes.body));
      expect(stageGateAfterActivityPayload.item.stage_2).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "thread_rebinds",
            value: "1",
          }),
        ]),
      );
    });
  });
});

class ReadableFromString {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    yield this.value;
  }
}

describe("workflow cli", () => {
  it("supports summary, task creation, and subtask cancellation", async () => {
    await withWorkflowStateDir(async () => {
      const pluginConfig = {
        roles: { planner: ["pm"], reviewer: ["qa"], patrol: ["ops"] },
      };
      const program = new Command();
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        registerWorkflowCli({ program, pluginConfig });

        await program.parseAsync(["workflow", "tasks", "create", "CLI Task"], { from: "user" });
        const createdTask = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
        expect(createdTask.name).toBe("CLI Task");

        const store = getWorkflowStore(pluginConfig);
        const subtask = store.createSubtask({
          taskId: createdTask.id,
          name: "CLI Subtask",
          assignedAgentId: "dev1",
          actor: { agentId: "pm" },
        });

        await program.parseAsync(["workflow", "summary"], { from: "user" });
        const summary = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
        expect(summary.tasks.active).toBe(1);
        expect(summary.subtasks.assigned).toBe(1);

        await program.parseAsync(["workflow", "stage-gates"], { from: "user" });
        const stageGates = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
        expect(stageGates.stage_1).toBeInstanceOf(Array);
        expect(stageGates.stage_2).toBeInstanceOf(Array);

        await program.parseAsync(
          [
            "workflow",
            "subtasks",
            "cancel",
            subtask.id,
            "--actor",
            "pm",
            "--summary",
            "cli cancel",
          ],
          { from: "user" },
        );
        const cancelled = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
        expect(cancelled.status).toBe("cancelled");
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
