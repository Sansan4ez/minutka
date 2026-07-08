export type WorkRelevance = "work_related" | "ambiguous" | "out_of_scope";

export type WorkPolicyReason =
  | "workday_reflection"
  | "planning_or_prioritization"
  | "work_emotional_state"
  | "content_generation_request"
  | "web_research_request"
  | "ai_training_request"
  | "non_work_topic"
  | "unknown";

export type WorkPolicyDecision = {
  relevance: WorkRelevance;
  allowedForAgent: boolean;
  shouldExtractInsights: boolean;
  reason: WorkPolicyReason;
  refusalResponse?: string;
};
