import { inferWorkflowRole, roleSummary } from "./config.js";

export function WORKFLOW_PROMPT_GUIDANCE(agentId: string | undefined, configInput: unknown): string {
  const role = inferWorkflowRole(agentId, configInput);
  const configuredRoles = roleSummary(configInput);
  const header = [
    "## Workflow",
    `You participate in the optional workflow plugin as role=${role}.`,
    "Use the `workflow` tool instead of inventing task state from memory.",
    "When a run starts, call `workflow` with `action: \"pull_queue\"` before making workflow decisions.",
  ];
  if (configuredRoles) {
    header.push(`Configured role bindings: ${configuredRoles}.`);
  }

  if (role === "planner") {
    header.push(
      'Planner actions: `queue_summary`, `stage_gates`, `create_task`, `list_tasks`, `plan_subtasks`, `create_subtask`, `list_subtasks`, `reassign_subtask`, `cancel_subtask`, `log_activity`.',
      "Prefer small executable subtasks with explicit deliverable and acceptance fields.",
      "Mark high-risk subtasks up front when work touches schema, auth, releases, or broad cross-cutting changes.",
      "When governance requires manual intervention, record `thread_rebound`, `manual_takeover`, or `review_timeout_takeover` via `log_activity`.",
      "Prioritize blocked work first, then pending work, then new decomposition.",
    );
  } else if (role === "reviewer") {
    header.push(
      'Reviewer actions: `pull_queue`, `stage_gates`, `review_subtask`, `get_subtask`, `log_activity`.',
      "A rejected review must include concrete issues. Use approved only when the deliverable is actually acceptable.",
    );
  } else if (role === "patrol") {
    header.push(
      'Patrol actions: `pull_queue`, `queue_summary`, `stage_gates`, `block_subtask`, `unblock_subtask`, `log_activity`.',
      "Only mark work blocked when it is stale or genuinely wedged. Include a short operational reason.",
      "If you manually rebind a thread or take over a stalled flow, record it with `log_activity` using the standard action names.",
    );
  } else {
    header.push(
      'Executor actions: `pull_queue`, `claim_subtask`, `start_subtask`, `submit_subtask`, `handoff_subtask`, `get_subtask`, `log_activity`.',
      "Do not work on a subtask you have not claimed or that is assigned to another agent.",
      "A review-ready submission must include change evidence, test summary, and delivery summary.",
      "If the change is risky, set the high-risk flag and risk tags before sending it to review.",
    );
  }

  return `${header.join("\n")}\n`;
}
