import type { ConversationTurnOrigin, WorkRetrospectiveEvent } from "../domain/work-retrospective.js";

export type ConversationTurn = {
  messageId: string;
  employeeId: string;
  /** Research correlation only; never used to authorize conversation reads. */
  subjectKey: string;
  threadId: string;
  userText: string;
  agentResponse: string;
  timestamp: string;
  /** Application/transport supplied. Missing legacy provenance means unknown, never employee. */
  origin?: ConversationTurnOrigin;
  /** Canonical events persisted atomically with this turn; delivery is a separate event. */
  retrospectiveEvents?: WorkRetrospectiveEvent[];
  retrospectiveDeliveryScope?: import("../domain/work-retrospective.js").RetrospectiveScope;
  scheduledProvenance?: import("./retrospective-delivery.js").ScheduledDeliveryProvenance;
};

export function conversationTurnOrigin(turn: ConversationTurn): ConversationTurnOrigin {
  return turn.origin ?? "unknown";
}

/** Canonical application conversation history. */
export type ConversationStore = {
  appendTurn(turn: ConversationTurn): Promise<void>;
  getRecentTurns(input: {
    employeeId: string;
    threadId: string;
    limit: number;
  }): Promise<ConversationTurn[]>;
  /** Returns the oldest chronological batch outside the newest window, optionally after a summary watermark. */
  getTurnsBeforeRecent(input: {
    employeeId: string;
    threadId: string;
    recentLimit: number;
    limit: number;
    afterMessageId?: string;
  }): Promise<ConversationTurn[]>;
  getTurnByMessageId(input: {
    employeeId: string;
    threadId: string;
    messageId: string;
  }): Promise<ConversationTurn | undefined>;
};
