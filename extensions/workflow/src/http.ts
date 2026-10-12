import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "../api.js";
import { renderWorkflowDashboard } from "./dashboard.js";
import { getWorkflowStore } from "./db.js";
import { planSubtasksForTask } from "./planner.js";

const BASE_PATH = "/plugins/workflow";

export function createWorkflowHttpHandler(params: { api: OpenClawPluginApi }) {
  const store = getWorkflowStore(params.api.pluginConfig, params.api.logger);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = parseRequestUrl(req.url);
    if (!url || !url.pathname.startsWith(BASE_PATH)) {
      return false;
    }

    const route = url.pathname.slice(BASE_PATH.length) || "/";
    try {
      if (req.method === "GET" && route === "/") {
        if (wantsHtml(req)) {
          const taskStatus = queryValue(url, "taskStatus");
          const subtaskStatus = queryValue(url, "subtaskStatus");
          const currentRole = queryValue(url, "currentRole");
          const highRisk = queryBoolean(url, "highRisk");
          const observationRole = queryValue(url, "observationRole");
          const observationHighRisk = queryBoolean(url, "observationHighRisk");
          const activityAction = queryValue(url, "activityAction");
          return html(
            res,
            200,
            renderWorkflowDashboard({
              basePath: BASE_PATH,
              configInput: params.api.pluginConfig,
              filters: {
                taskStatus,
                subtaskStatus,
                currentRole,
                highRisk,
                observationRole,
                observationHighRisk,
                activityAction,
              },
              summary: store.queueSummary(),
              metrics: store.governanceMetrics(),
              stageGates: store.stageGateSummary(),
              tasks: store.listTasks({ status: taskStatus, limit: 12 }),
              subtasks: store.listSubtasks({
                status: subtaskStatus,
                currentRole,
                highRisk,
                limit: 20,
              }),
              observations: store.listObservationSubtasks({
                currentRole: observationRole,
                highRisk: observationHighRisk,
                limit: 12,
              }),
              reviews: store.listReviews({ limit: 8 }),
              activity: store.listActivity({ action: activityAction, limit: 12 }),
            }),
          );
        }
        return json(res, 200, {
          ok: true,
          plugin: "workflow",
          routes: [
            "GET /plugins/workflow/queue-summary",
            "GET /plugins/workflow/stage-gates",
            "GET /plugins/workflow/tasks",
            "POST /plugins/workflow/tasks",
            "GET /plugins/workflow/tasks/:id",
            "POST /plugins/workflow/tasks/:id/plan-subtasks",
            "GET /plugins/workflow/subtasks",
            "POST /plugins/workflow/subtasks",
            "GET /plugins/workflow/subtasks/:id",
            "GET /plugins/workflow/observations",
            "POST /plugins/workflow/subtasks/:id/submit",
            "POST /plugins/workflow/subtasks/:id/handoff",
            "POST /plugins/workflow/subtasks/:id/unblock",
            "POST /plugins/workflow/subtasks/:id/cancel",
            "GET /plugins/workflow/reviews",
            "GET /plugins/workflow/activity",
            "POST /plugins/workflow/activity",
          ],
        });
      }

      if (req.method === "GET" && route === "/queue-summary") {
        return json(res, 200, {
          ok: true,
          item: store.queueSummary(),
        });
      }

      if (req.method === "GET" && route === "/stage-gates") {
        return json(res, 200, {
          ok: true,
          item: store.stageGateSummary(),
        });
      }

      if (req.method === "GET" && route === "/tasks") {
        return json(res, 200, {
          ok: true,
          items: store.listTasks({
            status: queryValue(url, "status"),
            limit: queryInt(url, "limit"),
          }),
        });
      }

      if (req.method === "POST" && route === "/tasks") {
        const body = await readJsonBody(req);
        return json(res, 201, {
          ok: true,
          item: store.createTask({
            name: requiredBodyString(body, "name"),
            description: optionalBodyString(body, "description"),
            actor: { agentId: optionalBodyString(body, "actor_agent_id") ?? "operator" },
          }),
        });
      }

      if (req.method === "GET" && route.startsWith("/tasks/")) {
        const id = route.slice("/tasks/".length);
        const task = store.getTask(id);
        return task
          ? json(res, 200, { ok: true, item: task })
          : json(res, 404, { ok: false, error: `task not found: ${id}` });
      }

      if (req.method === "POST" && route.startsWith("/tasks/") && route.endsWith("/plan-subtasks")) {
        const id = route.slice("/tasks/".length, -"/plan-subtasks".length);
        const task = store.getTask(id);
        if (!task) {
          return json(res, 404, { ok: false, error: `task not found: ${id}` });
        }
        const body = await readJsonBody(req);
        const drafts = planSubtasksForTask({
          task,
          source: optionalBodyString(body, "plan"),
          defaultAssignedAgentId: optionalBodyString(body, "assigned_agent_id"),
          existingSubtasks: store.listSubtasks({ taskId: id }),
        });
        const persist = optionalBodyBoolean(body, "persist") ?? false;
        const created = persist
          ? drafts.map((draft) =>
              store.createSubtask({
                taskId: id,
                name: draft.name,
                description: draft.description,
                deliverable: draft.deliverable,
                acceptance: draft.acceptance,
                priority: draft.priority,
                isHighRisk: draft.isHighRisk,
                riskTags: draft.riskTags,
                assignedAgentId: draft.assignedAgentId,
                actor: { agentId: optionalBodyString(body, "actor_agent_id") ?? "operator" },
              }),
            )
          : [];
        return json(res, persist ? 201 : 200, {
          ok: true,
          item: {
            task,
            drafts,
            persisted: persist,
            created,
          },
        });
      }

      if (req.method === "GET" && route === "/subtasks") {
        return json(res, 200, {
          ok: true,
          items: store.listSubtasks({
            taskId: queryValue(url, "taskId"),
            status: queryValue(url, "status"),
            assignedAgentId: queryValue(url, "assignedAgentId"),
            currentRole: queryValue(url, "currentRole"),
            highRisk: queryBoolean(url, "highRisk"),
            limit: queryInt(url, "limit"),
          }),
        });
      }

      if (req.method === "GET" && route === "/observations") {
        return json(res, 200, {
          ok: true,
          metrics: store.governanceMetrics(),
          items: store.listObservationSubtasks({
            limit: queryInt(url, "limit"),
            currentRole: queryValue(url, "currentRole"),
            highRisk: queryBoolean(url, "highRisk"),
          }),
        });
      }

      if (req.method === "POST" && route === "/subtasks") {
        const body = await readJsonBody(req);
        return json(res, 201, {
          ok: true,
          item: store.createSubtask({
            taskId: requiredBodyString(body, "task_id"),
            name: requiredBodyString(body, "name"),
            description: optionalBodyString(body, "description"),
            deliverable: optionalBodyString(body, "deliverable"),
            acceptance: optionalBodyString(body, "acceptance"),
            priority: optionalBodyString(body, "priority"),
            assignedAgentId: optionalBodyString(body, "assigned_agent_id"),
            isHighRisk: optionalBodyBoolean(body, "is_high_risk"),
            riskTags: optionalBodyString(body, "risk_tags"),
            actor: { agentId: optionalBodyString(body, "actor_agent_id") ?? "operator" },
          }),
        });
      }

      if (req.method === "GET" && route.startsWith("/subtasks/")) {
        const id = route.slice("/subtasks/".length);
        const subtask = store.getSubtask(id);
        return subtask
          ? json(res, 200, { ok: true, item: subtask })
          : json(res, 404, { ok: false, error: `subtask not found: ${id}` });
      }

      if (req.method === "POST" && route.startsWith("/subtasks/") && route.endsWith("/submit")) {
        const id = route.slice("/subtasks/".length, -"/submit".length);
        const body = await readJsonBody(req);
        return json(res, 200, {
          ok: true,
          item: store.submitSubtask({
            subtaskId: id,
            agentId: requiredBodyString(body, "actor_agent_id"),
            commitRef: optionalBodyString(body, "commit_ref"),
            changeSummary: optionalBodyString(body, "change_summary"),
            testSummary: optionalBodyString(body, "test_summary"),
            deliverySummary: optionalBodyString(body, "delivery_summary"),
            riskSummary: optionalBodyString(body, "risk_summary"),
            isHighRisk: optionalBodyBoolean(body, "is_high_risk"),
            riskTags: optionalBodyString(body, "risk_tags"),
            baseRef: optionalBodyString(body, "base_ref"),
            branchRef: optionalBodyString(body, "branch_ref"),
          }),
        });
      }

      if (req.method === "POST" && route.startsWith("/subtasks/") && route.endsWith("/handoff")) {
        const id = route.slice("/subtasks/".length, -"/handoff".length);
        const body = await readJsonBody(req);
        return json(res, 200, {
          ok: true,
          item: store.handoffSubtask({
            subtaskId: id,
            agentId: requiredBodyString(body, "actor_agent_id"),
            baseRef: optionalBodyString(body, "base_ref"),
            branchRef: optionalBodyString(body, "branch_ref"),
            commitRef: optionalBodyString(body, "commit_ref"),
            testSummary: optionalBodyString(body, "test_summary"),
            handoffSummary: requiredBodyString(body, "handoff_summary"),
            riskSummary: optionalBodyString(body, "risk_summary"),
            isHighRisk: optionalBodyBoolean(body, "is_high_risk"),
            riskTags: optionalBodyString(body, "risk_tags"),
          }),
        });
      }

      if (req.method === "POST" && route.startsWith("/subtasks/") && route.endsWith("/unblock")) {
        const id = route.slice("/subtasks/".length, -"/unblock".length);
        const body = await readJsonBody(req);
        return json(res, 200, {
          ok: true,
          item: store.unblockSubtask({
            subtaskId: id,
            agentId: requiredBodyString(body, "actor_agent_id"),
            resolution: requiredBodyString(body, "resolution_summary"),
            assignedAgentId: optionalBodyString(body, "assigned_agent_id"),
          }),
        });
      }

      if (req.method === "POST" && route.startsWith("/subtasks/") && route.endsWith("/cancel")) {
        const id = route.slice("/subtasks/".length, -"/cancel".length);
        const body = await readJsonBody(req);
        return json(res, 200, {
          ok: true,
          item: store.cancelSubtask({
            subtaskId: id,
            agentId: optionalBodyString(body, "actor_agent_id") ?? "operator",
            summary: optionalBodyString(body, "summary"),
          }),
        });
      }

      if (req.method === "GET" && route === "/reviews") {
        return json(res, 200, {
          ok: true,
          items: store.listReviews({
            subtaskId: queryValue(url, "subtaskId"),
            limit: queryInt(url, "limit"),
          }),
        });
      }

      if (req.method === "GET" && route === "/activity") {
        return json(res, 200, {
          ok: true,
          items: store.listActivity({
            taskId: queryValue(url, "taskId"),
            action: queryValue(url, "action"),
            limit: queryInt(url, "limit"),
          }),
        });
      }

      if (req.method === "POST" && route === "/activity") {
        const body = await readJsonBody(req);
        return json(res, 201, {
          ok: true,
          item: store.createActivity({
            agentId: optionalBodyString(body, "actor_agent_id") ?? "operator",
            subtaskId: optionalBodyString(body, "subtask_id"),
            action: requiredBodyString(body, "action"),
            summary: requiredBodyString(body, "summary"),
            sessionKey: optionalBodyString(body, "session_key"),
          }),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.api.logger.warn(`workflow http error: ${message}`);
      return json(res, 400, { ok: false, error: message });
    }

    return json(res, 404, { ok: false, error: `unknown workflow route: ${route}` });
  };
}

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function queryValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value?.trim() ? value.trim() : undefined;
}

function queryInt(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function queryBoolean(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key)?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function wantsHtml(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? "").toLowerCase();
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBodyBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): boolean {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, 2));
  return true;
}

function html(res: ServerResponse, statusCode: number, body: string): boolean {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
  return true;
}
