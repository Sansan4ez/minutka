export type ChatMessageReceived = {
  type: "ChatMessageReceived";
  employeeId: string;
  threadId: string;
  text: string;
  timestamp: string;
};

export type ChatResponseGenerated = {
  type: "ChatResponseGenerated";
  employeeId: string;
  threadId: string;
  response: string;
  timestamp: string;
};

export type DomainEvent =
  | ChatMessageReceived
  | ChatResponseGenerated;
