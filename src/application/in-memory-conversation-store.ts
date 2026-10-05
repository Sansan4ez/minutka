import type { InMemoryWorld } from "./in-memory-world.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";

import { isDeepStrictEqual } from "node:util";
import { PersistenceError } from "./persistence-error.js";
import { metadataFor, mergeDeliveryEvents, selectEvents, validateEvents, type RetrospectiveEventStore } from "./retrospective-event-store.js";

export function createInMemoryConversationStore(world: InMemoryWorld): ConversationStore & RetrospectiveEventStore {
  return {
    async appendTurn(turn) {
      const metadata = metadataFor(turn);
      validateEvents(turn, turn.retrospectiveEvents ?? []);
      const existing = world.messages.find((message) => message.id === turn.messageId);
      if (existing) {
        if (!isDeepStrictEqual(toTurn(existing), turn)) throw new PersistenceError("persistence_conflict");
        return;
      }
      for (const event of turn.retrospectiveEvents ?? []) {
        const owner = world.participants.find((participant) => participant.employeeId === turn.employeeId);
        if (!owner || owner.companyId !== event.companyId || owner.groupId !== event.groupId || owner.subjectKey !== event.subjectKey) {
          throw new PersistenceError("persistence_conflict");
        }
      }
      world.messages.push({
        metadata,
        id: turn.messageId,
        employeeId: turn.employeeId,
        subjectKey: turn.subjectKey,
        threadId: turn.threadId,
        text: turn.userText,
        response: turn.agentResponse,
        timestamp: turn.timestamp,
      });
    },

    async readEvents(request) {
      return selectEvents(world.messages.filter((message) => message.employeeId === request.scope.employeeId && message.threadId === request.scope.threadId)
        .flatMap((message) => [...(message.metadata?.retrospectiveEvents ?? []), ...(message.metadata?.deliveryEvents ?? [])]), request);
    },

    async appendDeliveryEvents(request) {
      const message = world.messages.find((candidate) => candidate.id === request.sourceMessageId
        && candidate.employeeId === request.scope.employeeId && candidate.threadId === request.scope.threadId);
      if (!message) throw new PersistenceError("message_not_found");
      message.metadata = mergeDeliveryEvents(toTurn(message), message.metadata ?? null, request.scope, request.events);
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

    async getTurnsBeforeRecent(input) {
      const turns = world.messages
        .filter(
          (message) =>
            message.employeeId === input.employeeId &&
            message.threadId === input.threadId,
        )
        .map(toTurn);
      const limit = Math.max(0, input.limit);
      if (limit === 0) return [];
      const outsideRecent = turns.slice(0, Math.max(0, turns.length - Math.max(0, input.recentLimit)));
      if (!input.afterMessageId) return outsideRecent.slice(0, limit);
      const watermarkIndex = outsideRecent.findIndex((turn) => turn.messageId === input.afterMessageId);
      return (watermarkIndex < 0 ? outsideRecent : outsideRecent.slice(watermarkIndex + 1)).slice(0, limit);
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
    subjectKey: message.subjectKey,
    threadId: message.threadId,
    userText: message.text,
    agentResponse: message.response,
    timestamp: message.timestamp,
    ...(message.metadata?.origin === undefined ? {} : { origin: message.metadata.origin }),
    ...(message.metadata?.retrospectiveDeliveryScope ? { retrospectiveDeliveryScope: structuredClone(message.metadata.retrospectiveDeliveryScope) } : {}),
    ...(message.metadata?.scheduledProvenance ? { scheduledProvenance: structuredClone(message.metadata.scheduledProvenance) } : {}),
    ...(message.metadata?.retrospectiveEvents === undefined ? {} : { retrospectiveEvents: structuredClone(message.metadata.retrospectiveEvents) }),
  };
}
