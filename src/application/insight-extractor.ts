import type { UserProfile } from "../domain/employee.js";
import type { StructuredInsightDraft } from "../domain/insights.js";
import type { ConversationDecision } from "../domain/conversation-decision.js";
import type { ConversationTurn } from "./conversation-memory-store.js";

export type InsightExtractionInput = {
  employeeId: string;
  threadId: string;
  messageId: string;
  text: string;
  response: string;
  profile?: UserProfile;
  recentTurns: ConversationTurn[];
  decision: ConversationDecision;
};

export type InsightExtractionResult = {
  insights: StructuredInsightDraft[];
};

export type InsightExtractor = (
  input: InsightExtractionInput,
) => Promise<InsightExtractionResult>;
