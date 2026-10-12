import type { SubtaskRecord, TaskRecord } from "./schema.js";

export type PlannedSubtaskDraft = {
  name: string;
  description?: string;
  deliverable?: string;
  acceptance?: string;
  priority: string;
  isHighRisk?: boolean;
  riskTags?: string;
  assignedAgentId?: string;
};

export function planSubtasksForTask(params: {
  task: TaskRecord;
  source?: string;
  defaultAssignedAgentId?: string;
  existingSubtasks?: SubtaskRecord[];
}): PlannedSubtaskDraft[] {
  const existingNames = new Set(
    (params.existingSubtasks ?? []).map((item) => normalizeKey(item.name)),
  );
  const source = params.source?.trim() || params.task.description.trim();
  const parsed = source ? parseStructuredDrafts(source, params.defaultAssignedAgentId) : [];
  const drafts = parsed.length > 0 ? parsed : buildFallbackDrafts(params.task, params.defaultAssignedAgentId);

  return drafts
    .filter((item) => !existingNames.has(normalizeKey(item.name)))
    .slice(0, 12);
}

function parseStructuredDrafts(
  source: string,
  defaultAssignedAgentId?: string,
): PlannedSubtaskDraft[] {
  const entries: string[][] = [];
  let current: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) {
      if (current.length > 0) {
        entries.push(current);
      }
      current = [line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim()];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    entries.push(current);
  }

  if (entries.length === 0) {
    return [];
  }

  return entries
    .map((entry) => parseEntry(entry, defaultAssignedAgentId))
    .filter((item): item is PlannedSubtaskDraft => item !== null);
}

function parseEntry(lines: string[], defaultAssignedAgentId?: string): PlannedSubtaskDraft | null {
  const [firstLine, ...rest] = lines;
  const draft: PlannedSubtaskDraft = {
    name: "",
    priority: "medium",
    assignedAgentId: cleanValue(defaultAssignedAgentId),
  };

  const [nameSegment, ...segments] = firstLine.split("|").map((part) => part.trim()).filter(Boolean);
  draft.name = nameSegment ?? "";
  for (const segment of segments) {
    applyFieldSegment(draft, segment);
  }
  for (const line of rest) {
    applyFieldSegment(draft, line);
  }

  draft.name = cleanValue(draft.name) ?? "";
  if (!draft.name) {
    return null;
  }

  draft.description = cleanValue(draft.description);
  draft.deliverable = cleanValue(draft.deliverable) ?? `Working output for "${draft.name}".`;
  draft.acceptance =
    cleanValue(draft.acceptance) ?? `The requested output for "${draft.name}" is complete and reviewable.`;
  draft.assignedAgentId = cleanValue(draft.assignedAgentId);
  draft.priority = normalizePriority(draft.priority);
  draft.isHighRisk = inferHighRiskFlag(draft);
  draft.riskTags = inferRiskTags(draft);
  return draft;
}

function applyFieldSegment(draft: PlannedSubtaskDraft, segment: string): void {
  const match = /^(description|deliverable|acceptance|priority|owner|assigned_agent_id|assignedagentid|risk|risk_tags|risktags|high_risk|ishighrisk)\s*:\s*(.+)$/i.exec(
    segment,
  );
  if (!match) {
    if (!draft.description) {
      draft.description = segment;
    } else {
      draft.description = `${draft.description}\n${segment}`;
    }
    return;
  }

  const key = match[1].toLowerCase();
  const value = match[2].trim();
  switch (key) {
    case "description":
      draft.description = value;
      break;
    case "deliverable":
      draft.deliverable = value;
      break;
    case "acceptance":
      draft.acceptance = value;
      break;
    case "priority":
      draft.priority = value;
      break;
    case "owner":
    case "assigned_agent_id":
    case "assignedagentid":
      draft.assignedAgentId = value;
      break;
    case "risk":
    case "risk_tags":
    case "risktags":
      draft.riskTags = value;
      break;
    case "high_risk":
    case "ishighrisk":
      draft.isHighRisk = /^(true|1|yes|y)$/i.test(value);
      break;
  }
}

function buildFallbackDrafts(
  task: TaskRecord,
  defaultAssignedAgentId?: string,
): PlannedSubtaskDraft[] {
  const assignedAgentId = cleanValue(defaultAssignedAgentId);
  return [
    {
      name: `Clarify scope for ${task.name}`,
      description: `Identify constraints, dependencies, and the minimal acceptable scope for "${task.name}".`,
      deliverable: `A short implementation plan for "${task.name}".`,
      acceptance: "Dependencies, risks, and intended scope are explicit.",
      priority: "medium",
      assignedAgentId,
    },
    {
      name: `Implement core work for ${task.name}`,
      description: `Execute the main implementation needed to complete "${task.name}".`,
      deliverable: `Working changes covering the main objective of "${task.name}".`,
      acceptance: "Core behavior is implemented and ready for focused review.",
      priority: "high",
      isHighRisk: inferHighRiskFlag({
        name: `Implement core work for ${task.name}`,
        description: `Execute the main implementation needed to complete "${task.name}".`,
        deliverable: `Working changes covering the main objective of "${task.name}".`,
        acceptance: "Core behavior is implemented and ready for focused review.",
        priority: "high",
      }),
      riskTags: inferRiskTags({
        name: `Implement core work for ${task.name}`,
        description: `Execute the main implementation needed to complete "${task.name}".`,
        deliverable: `Working changes covering the main objective of "${task.name}".`,
        acceptance: "Core behavior is implemented and ready for focused review.",
        priority: "high",
      }),
      assignedAgentId,
    },
    {
      name: `Verify and hand off ${task.name}`,
      description: `Run validation and record follow-up items for "${task.name}".`,
      deliverable: `Verification notes, final checks, and any remaining risk notes.`,
      acceptance: "Validation has been performed and remaining risks are documented.",
      priority: "medium",
      assignedAgentId,
    },
  ];
}

function normalizePriority(value: string | undefined): string {
  const normalized = cleanValue(value)?.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "medium";
}

function inferHighRiskFlag(draft: PlannedSubtaskDraft): boolean {
  const explicit = draft.isHighRisk;
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return inferRiskTags(draft).length > 0;
}

function inferRiskTags(draft: PlannedSubtaskDraft): string {
  const tags = new Set(splitTags(draft.riskTags));
  const text = [
    draft.name,
    draft.description,
    draft.deliverable,
    draft.acceptance,
  ]
    .filter(Boolean)
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
  if (draft.priority === "high" && tags.size > 0) {
    tags.add("high_priority");
  }
  return Array.from(tags).join(",");
}

function cleanValue(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

function splitTags(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n|]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
