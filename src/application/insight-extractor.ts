import type { UserProfile } from "../domain/employee.js";
import type { StructuredInsightDraft } from "../domain/insights.js";
import type { WorkPolicyDecision } from "../domain/work-policy.js";
import type { ConversationTurn } from "./conversation-memory-store.js";

export type InsightExtractionInput = {
  employeeId: string;
  threadId: string;
  messageId: string;
  text: string;
  response: string;
  profile?: UserProfile;
  recentTurns: ConversationTurn[];
  policy: WorkPolicyDecision;
};

export type InsightExtractionResult = {
  insights: StructuredInsightDraft[];
};

export type InsightExtractor = (
  input: InsightExtractionInput,
) => Promise<InsightExtractionResult>;
