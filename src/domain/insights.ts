export const insightKinds = [
  "task_category",
  "routine_pattern",
  "energy_stress_marker",
  "automation_candidate",
] as const;

export type InsightKind = (typeof insightKinds)[number];

export type InsightConfidence = "low" | "medium" | "high";

export const taskCategories = [
  "planning",
  "reporting",
  "meetings",
  "coordination",
  "communication",
  "admin",
  "focus_work",
  "unknown",
] as const;

export type TaskCategory = (typeof taskCategories)[number];

export const routinePatternTypes = [
  "meeting_overload",
  "context_switching",
  "manual_reporting",
  "coordination_overhead",
  "waiting_for_input",
  "unclear_priority",
  "other",
] as const;

export type RoutinePatternType = (typeof routinePatternTypes)[number];

export const energyStressMarkerTypes = [
  "overload",
  "fatigue",
  "frustration",
  "focus_loss",
  "blocked_progress",
  "neutral",
] as const;

export type EnergyStressMarkerType = (typeof energyStressMarkerTypes)[number];

export const automationCandidateTypes = [
  "report_generation",
  "meeting_reduction",
  "async_status_update",
  "task_routing",
  "template_or_checklist",
  "data_entry_reduction",
  "other",
] as const;

export type AutomationCandidateType = (typeof automationCandidateTypes)[number];

export const activityDurationBuckets = [
  "lt_15m",
  "15_30m",
  "30_60m",
  "1_2h",
  "2_4h",
  "gt_4h",
] as const;

export type ActivityDurationBucket = (typeof activityDurationBuckets)[number];

/** Global closed dictionary; additions require a code change, never company input. */
export const activitySystems = [
  "bitrix24",
  "one_c",
  "spreadsheets",
  "email",
  "messengers",
  "crm",
  "task_tracker",
  "paper_or_verbal",
  "other",
] as const;

export type ActivitySystem = (typeof activitySystems)[number];

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
