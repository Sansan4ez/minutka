import type { ChatMessage, InMemoryWorld } from "./in-memory-world.js";
import type { MessageStore } from "./message-store.js";

export function createInMemoryMessageStore(world: InMemoryWorld): MessageStore {
  return {
    async getMessageById(input: {
      messageId: string;
      employeeId: string;
      threadId: string;
    }): Promise<ChatMessage | undefined> {
      return world.messages.find(
        (m) =>
          m.id === input.messageId &&
          m.employeeId === input.employeeId &&
          m.threadId === input.threadId
      );
    },
  };
}
