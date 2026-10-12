import type { Command } from "commander";
import type { PluginLogger } from "../api.js";
import { getWorkflowStore } from "./db.js";

type RegisterWorkflowCliParams = {
  program: Command;
  pluginConfig: unknown;
  logger?: PluginLogger;
};

export function registerWorkflowCli(params: RegisterWorkflowCliParams): void {
  const store = getWorkflowStore(params.pluginConfig, params.logger);
  const workflow = params.program.command("workflow").description("Workflow plugin commands");

  workflow
    .command("summary")
    .description("Show workflow queue summary")
    .action(() => {
      printJson(store.queueSummary());
    });

  workflow
    .command("stage-gates")
    .description("Show quantified workflow stage gates")
    .action(() => {
      printJson(store.stageGateSummary());
    });

  const tasks = workflow.command("tasks").description("Task commands");

  tasks
    .command("list")
    .description("List workflow tasks")
    .option("--status <status>", "Filter by task status")
    .option("--limit <n>", "Limit rows", parseLimit)
    .action((opts: { status?: string; limit?: number }) => {
      printJson(store.listTasks({ status: opts.status, limit: opts.limit }));
    });

  tasks
    .command("create")
    .description("Create a workflow task")
    .argument("<name>", "Task name")
    .option("--description <text>", "Task description")
    .option("--actor <agentId>", "Planner or operator agent id", "operator")
    .action((name: string, opts: { description?: string; actor?: string }) => {
      printJson(
        store.createTask({
          name,
          description: opts.description,
          actor: { agentId: opts.actor },
        }),
      );
    });

  const subtasks = workflow.command("subtasks").description("Subtask commands");

  subtasks
    .command("list")
    .description("List workflow subtasks")
    .option("--task-id <taskId>", "Filter by task id")
    .option("--status <status>", "Filter by subtask status")
    .option("--current-role <role>", "Filter by current workflow role")
    .option("--high-risk <bool>", "Filter by high-risk subtasks", parseBoolean)
    .option("--assigned-agent-id <agentId>", "Filter by assigned agent id")
    .option("--limit <n>", "Limit rows", parseLimit)
    .action((opts: {
      taskId?: string;
      status?: string;
      currentRole?: string;
      highRisk?: boolean;
      assignedAgentId?: string;
      limit?: number;
    }) => {
      printJson(
        store.listSubtasks({
          taskId: opts.taskId,
          status: opts.status,
          currentRole: opts.currentRole,
          highRisk: opts.highRisk,
          assignedAgentId: opts.assignedAgentId,
          limit: opts.limit,
        }),
      );
    });

  subtasks
    .command("cancel")
    .description("Cancel a workflow subtask")
    .argument("<subtaskId>", "Subtask id")
    .option("--actor <agentId>", "Planner or operator agent id", "operator")
    .option("--summary <text>", "Optional cancellation summary")
    .action((subtaskId: string, opts: { actor?: string; summary?: string }) => {
      printJson(
        store.cancelSubtask({
          subtaskId,
          agentId: opts.actor ?? "operator",
          summary: opts.summary,
        }),
      );
    });
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive number");
  }
  return Math.floor(parsed);
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error("value must be true/false");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
