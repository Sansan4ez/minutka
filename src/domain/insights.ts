export type InsightKind =
  | "task_category"
  | "routine_pattern"
  | "energy_stress_marker"
  | "automation_candidate";

export type InsightConfidence = "low" | "medium" | "high";

export type TaskCategory =
  | "planning"
  | "reporting"
  | "meetings"
  | "coordination"
  | "communication"
  | "admin"
  | "focus_work"
  | "unknown";

export type RoutinePatternType =
  | "meeting_overload"
  | "context_switching"
  | "manual_reporting"
  | "coordination_overhead"
  | "waiting_for_input"
  | "unclear_priority"
  | "other";

export type EnergyStressMarkerType =
  | "overload"
  | "fatigue"
  | "frustration"
  | "focus_loss"
  | "blocked_progress"
  | "neutral";

export type AutomationCandidateType =
  | "report_generation"
  | "meeting_reduction"
  | "async_status_update"
  | "task_routing"
  | "template_or_checklist"
  | "data_entry_reduction"
  | "other";

export type InsightBase = {
  id: string;
  employeeId: string;
  threadId: string;
  sourceMessageId: string;
  kind: InsightKind;
  label: string;
  confidence: InsightConfidence;
  createdAt: string;
};

export type TaskCategoryInsight = InsightBase & {
  kind: "task_category";
  category: TaskCategory;
};

export type RoutinePatternInsight = InsightBase & {
  kind: "routine_pattern";
  patternType: RoutinePatternType;
  interferesWith?: string;
};

export type EnergyStressInsight = InsightBase & {
  kind: "energy_stress_marker";
  marker: EnergyStressMarkerType;
  intensity: "low" | "medium" | "high";
};

export type AutomationCandidateInsight = InsightBase & {
  kind: "automation_candidate";
  candidateType: AutomationCandidateType;
  rationale: string;
};

export type StructuredInsight =
  | TaskCategoryInsight
  | RoutinePatternInsight
  | EnergyStressInsight
  | AutomationCandidateInsight;

export type StructuredInsightDraft =
  | Omit<TaskCategoryInsight, "id" | "createdAt">
  | Omit<RoutinePatternInsight, "id" | "createdAt">
  | Omit<EnergyStressInsight, "id" | "createdAt">
  | Omit<AutomationCandidateInsight, "id" | "createdAt">;
