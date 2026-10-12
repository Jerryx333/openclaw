export type WorkflowRole = "planner" | "executor" | "reviewer" | "patrol";

export type TaskStatus = "planning" | "active" | "completed" | "cancelled";

export type SubtaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "review"
  | "rework"
  | "blocked"
  | "done"
  | "cancelled";

export type ReviewResult = "approved" | "rejected";

export type WorkflowPluginConfig = {
  dbPath?: string;
  roles?: {
    planner?: string[];
    reviewer?: string[];
    patrol?: string[];
  };
  staleMinutes?: {
    assigned?: number;
    inProgress?: number;
  };
};

export type TaskRecord = {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SubtaskRecord = {
  id: string;
  task_id: string;
  name: string;
  description: string;
  deliverable: string;
  acceptance: string;
  priority: string;
  status: SubtaskStatus;
  current_role: WorkflowRole | null;
  assigned_agent_id: string | null;
  current_session_key: string | null;
  is_high_risk: boolean;
  risk_tags: string;
  base_ref: string;
  branch_ref: string;
  latest_commit_ref: string;
  change_summary: string;
  test_summary: string;
  delivery_summary: string;
  risk_summary: string;
  handoff_summary: string;
  review_requested_at: string | null;
  blocked_at: string | null;
  blocked_by_agent_id: string | null;
  blocked_reason: string;
  blocked_resolution: string;
  rework_count: number;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ReviewRecord = {
  id: string;
  subtask_id: string;
  reviewer_agent_id: string;
  result: ReviewResult;
  score: number;
  wait_minutes: number | null;
  issues: string;
  comment: string;
  created_at: string;
};

export type ActivityLogRecord = {
  id: string;
  agent_id: string | null;
  subtask_id: string | null;
  action: string;
  summary: string;
  session_key: string | null;
  created_at: string;
};

export type GovernanceMetrics = {
  review_pending: number;
  blocked: number;
  high_risk_open: number;
  high_risk_review_pending: number;
  rework_rate: number | null;
  manual_takeovers_7d: number;
  review_timeout_takeovers_7d: number;
  thread_rebinds_7d: number;
  blocked_over_sla: number;
  rejected_reviews: number;
  total_reviews: number;
  avg_review_score: number | null;
  avg_review_wait_minutes: number | null;
  avg_rework_count_open: number | null;
  oldest_review_age_minutes: number | null;
  oldest_blocked_age_minutes: number | null;
};

export type StageGateCheck = {
  key: string;
  label: string;
  passed: boolean;
  value: string;
  target: string;
};

export type StageGateSummary = {
  stage_1_passed: boolean;
  stage_2_passed: boolean;
  stage_1: StageGateCheck[];
  stage_2: StageGateCheck[];
};
