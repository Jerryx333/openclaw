import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../api.js";
import type { WorkflowPluginConfig, WorkflowRole } from "./schema.js";

const DEFAULT_ASSIGNED_STALE_MINUTES = 30;
const DEFAULT_IN_PROGRESS_STALE_MINUTES = 120;

export function resolveWorkflowConfig(input: unknown): Required<WorkflowPluginConfig> {
  const config = (input ?? {}) as WorkflowPluginConfig;
  return {
    dbPath: typeof config.dbPath === "string" ? config.dbPath : "",
    roles: {
      planner: Array.isArray(config.roles?.planner) ? config.roles.planner.filter(isNonEmpty) : [],
      reviewer: Array.isArray(config.roles?.reviewer)
        ? config.roles.reviewer.filter(isNonEmpty)
        : [],
      patrol: Array.isArray(config.roles?.patrol) ? config.roles.patrol.filter(isNonEmpty) : [],
    },
    staleMinutes: {
      assigned:
        typeof config.staleMinutes?.assigned === "number" && config.staleMinutes.assigned > 0
          ? Math.floor(config.staleMinutes.assigned)
          : DEFAULT_ASSIGNED_STALE_MINUTES,
      inProgress:
        typeof config.staleMinutes?.inProgress === "number" && config.staleMinutes.inProgress > 0
          ? Math.floor(config.staleMinutes.inProgress)
          : DEFAULT_IN_PROGRESS_STALE_MINUTES,
    },
  };
}

export function resolveWorkflowDbPath(configInput: unknown): string {
  const config = resolveWorkflowConfig(configInput);
  const configured = config.dbPath.trim();
  if (configured) {
    if (configured.startsWith("~/")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return path.resolve(configured);
  }
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "plugins", "workflow", "workflow.sqlite");
}

export function inferWorkflowRole(agentId: string | undefined, configInput: unknown): WorkflowRole {
  const agent = agentId?.trim();
  if (!agent) {
    return "executor";
  }
  const config = resolveWorkflowConfig(configInput);
  if (config.roles.planner.includes(agent)) {
    return "planner";
  }
  if (config.roles.reviewer.includes(agent)) {
    return "reviewer";
  }
  if (config.roles.patrol.includes(agent)) {
    return "patrol";
  }
  return "executor";
}

export function roleSummary(configInput: unknown): string {
  const config = resolveWorkflowConfig(configInput);
  const parts: string[] = [];
  if (config.roles.planner.length > 0) {
    parts.push(`planner=${config.roles.planner.join(",")}`);
  }
  if (config.roles.reviewer.length > 0) {
    parts.push(`reviewer=${config.roles.reviewer.join(",")}`);
  }
  if (config.roles.patrol.length > 0) {
    parts.push(`patrol=${config.roles.patrol.join(",")}`);
  }
  return parts.join(" ");
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
