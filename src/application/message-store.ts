import type { ChatMessage } from "./in-memory-world.js";

export interface MessageStore {
  getMessageById(input: {
    messageId: string;
    employeeId: string;
    threadId: string;
  }): Promise<ChatMessage | undefined>;
}
