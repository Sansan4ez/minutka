export type ConversationTurn = {
  messageId: string;
  employeeId: string;
  threadId: string;
  userText: string;
  agentResponse: string;
  timestamp: string;
};

/** Canonical application conversation history. */
export type ConversationStore = {
  appendTurn(turn: ConversationTurn): Promise<void>;
  getRecentTurns(input: {
    employeeId: string;
    threadId: string;
    limit: number;
  }): Promise<ConversationTurn[]>;
  /** Returns the chronological turns outside the newest window, optionally after a summary watermark. */
  getTurnsBeforeRecent(input: {
    employeeId: string;
    threadId: string;
    recentLimit: number;
    afterMessageId?: string;
  }): Promise<ConversationTurn[]>;
  getTurnByMessageId(input: {
    employeeId: string;
    threadId: string;
    messageId: string;
  }): Promise<ConversationTurn | undefined>;
};
