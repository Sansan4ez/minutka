import type { InMemoryWorld } from "./in-memory-world.js";
import type {
  ConversationMemoryStore,
  ConversationTurn,
} from "./conversation-memory-store.js";

export function createInMemoryConversationMemory(
  world: InMemoryWorld,
): ConversationMemoryStore {
  return {
    async getRecentTurns(input) {
      const limit = Math.max(0, input.limit);
      if (limit === 0) return [];

      const turns: ConversationTurn[] = world.messages
        .filter(
          (message) =>
            message.employeeId === input.employeeId &&
            message.threadId === input.threadId,
        )
        .map((message) => ({
          messageId: message.id,
          employeeId: message.employeeId,
          threadId: message.threadId,
          userText: message.text,
          agentResponse: message.response,
          timestamp: message.timestamp,
        }));

      return turns.slice(-limit);
    },
  };
}
