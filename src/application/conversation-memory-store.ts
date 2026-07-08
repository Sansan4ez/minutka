export type ConversationTurn = {
  messageId: string;
  employeeId: string;
  threadId: string;
  userText: string;
  agentResponse: string;
  timestamp: string;
};

export type ConversationMemoryStore = {
  getRecentTurns(input: {
    employeeId: string;
    threadId: string;
    limit: number;
  }): Promise<ConversationTurn[]>;
};
