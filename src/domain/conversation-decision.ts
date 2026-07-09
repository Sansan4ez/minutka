import type { InsightKind } from "./insights.js";

export type DecisionProcessId =
  | "core"
  | "onboarding"
  | "consent_and_privacy"
  | "evening_reflection"
  | "workday_guardrails"
  | "insight_extraction"
  | "feedback";

export type ConversationBoundaryReason =
  | "content_generation_request"
  | "web_research_request"
  | "ai_training_request"
  | "non_work_topic"
  | "request_integrity_attack"
  | "unknown";

export type ConversationAllowReason =
  | "workday_reflection"
  | "planning_or_prioritization"
  | "work_emotional_state"
  | "onboarding"
  | "feedback"
  | "ambiguous"
  | "unknown";

export type ConversationWorkDecision =
  | {
      mode: "allow";
      reason: ConversationAllowReason;
    }
  | {
      mode: "boundary";
      reason: ConversationBoundaryReason;
      response?: string;
    };

export type ConversationInsightDecision = {
  candidate: boolean;
  suggestedKinds: InsightKind[];
};

export type ConversationDecision = {
  selectedProcessIds: DecisionProcessId[];
  workDecision: ConversationWorkDecision;
  insightDecision: ConversationInsightDecision;
};
