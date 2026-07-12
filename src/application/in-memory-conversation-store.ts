import type { InMemoryWorld } from "./in-memory-world.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";

export function createInMemoryConversationStore(world: InMemoryWorld): ConversationStore {
  return {
    async appendTurn(turn) {
      world.messages.push({
        id: turn.messageId,
        employeeId: turn.employeeId,
        threadId: turn.threadId,
        text: turn.userText,
        response: turn.agentResponse,
        timestamp: turn.timestamp,
      });
    },

    async getRecentTurns(input) {
      const limit = Math.max(0, input.limit);
      if (limit === 0) return [];
      return world.messages
        .filter(
          (message) =>
            message.employeeId === input.employeeId &&
            message.threadId === input.threadId,
        )
        .slice(-limit)
        .map(toTurn);
    },

    async getTurnByMessageId(input) {
      const message = world.messages.find(
        (candidate) =>
          candidate.id === input.messageId &&
          candidate.employeeId === input.employeeId &&
          candidate.threadId === input.threadId,
      );
      return message ? toTurn(message) : undefined;
    },
  };
}

function toTurn(message: InMemoryWorld["messages"][number]): ConversationTurn {
  return {
    messageId: message.id,
    employeeId: message.employeeId,
    threadId: message.threadId,
    userText: message.text,
    agentResponse: message.response,
    timestamp: message.timestamp,
  };
}
