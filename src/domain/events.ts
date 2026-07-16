import type { Persona } from "./employee.js";
import type { InsightKind } from "./insights.js";
import type { ConversationBoundaryReason, DecisionProcessId } from "./conversation-decision.js";
import type { FeedbackRating, FeedbackSource } from "./feedback.js";

export type ChatMessageReceived = {
  type: "ChatMessageReceived";
  employeeId: string;
  threadId: string;
  text: string;
  inputModality: "text" | "voice";
  timestamp: string;
};

export type ChatResponseGenerated = {
  type: "ChatResponseGenerated";
  employeeId: string;
  threadId: string;
  response: string;
  timestamp: string;
};

export type InviteOpened = {
  type: "InviteOpened";
  employeeId: string;
  inviteCode: string;
  timestamp: string;
};

export type PrivacyExplanationShown = {
  type: "PrivacyExplanationShown";
  employeeId: string;
  privacyVersion: string;
  timestamp: string;
};

export type ConsentAccepted = {
  type: "ConsentAccepted";
  employeeId: string;
  privacyVersion: string;
  timestamp: string;
};

export type UserProfileUpdated = {
  type: "UserProfileUpdated";
  employeeId: string;
  changedFields: string[];
  timestamp: string;
};

export type OnboardingCompleted = {
  type: "OnboardingCompleted";
  employeeId: string;
  persona: Persona;
  timestamp: string;
};

export type WorkBoundaryApplied = {
  type: "WorkBoundaryApplied";
  employeeId: string;
  threadId: string;
  reason: ConversationBoundaryReason;
  selectedProcessIds?: DecisionProcessId[];
  timestamp: string;
};

export type InsightRecorded = {
  type: "InsightRecorded";
  employeeId: string;
  threadId: string;
  insightId: string;
  kind: InsightKind;
  timestamp: string;
};

export type InsightExtractionFailed = {
  type: "InsightExtractionFailed";
  employeeId: string;
  threadId: string;
  reason: string;
  timestamp: string;
};

export type FeedbackReceived = {
  type: "FeedbackReceived";
  feedbackId: string;
  employeeId: string;
  threadId: string;
  targetMessageId: string;
  rating: FeedbackRating;
  source: FeedbackSource;
  timestamp: string;
};

export type AgentManualLoadFailed = {
  type: "AgentManualLoadFailed";
  reason: string;
  timestamp: string;
};

export type DomainEvent =
  | ChatMessageReceived
  | ChatResponseGenerated
  | InviteOpened
  | PrivacyExplanationShown
  | ConsentAccepted
  | UserProfileUpdated
  | OnboardingCompleted
  | WorkBoundaryApplied
  | InsightRecorded
  | InsightExtractionFailed
  | FeedbackReceived
  | AgentManualLoadFailed;
