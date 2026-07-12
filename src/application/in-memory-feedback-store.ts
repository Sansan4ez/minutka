import type { FeedbackRecord } from "../domain/feedback.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { FeedbackStore, SaveFeedbackInput } from "./feedback-store.js";

export function createInMemoryFeedbackStore(world: InMemoryWorld): FeedbackStore {
  return {
    async saveFeedback(input: SaveFeedbackInput): Promise<FeedbackRecord> {
      const index = world.feedback.findIndex(
        (feedback) =>
          feedback.employeeId === input.employeeId &&
          feedback.threadId === input.threadId &&
          feedback.targetMessageId === input.targetMessageId,
      );
      if (index === -1) {
        const record: FeedbackRecord = {
          id: input.id,
          employeeId: input.employeeId,
          threadId: input.threadId,
          targetMessageId: input.targetMessageId,
          rating: input.rating,
          source: input.source,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        };
        world.feedback.push(record);
        return record;
      }
      const existing = world.feedback[index];
      const record: FeedbackRecord = {
        ...existing,
        rating: input.rating,
        source: input.source,
        updatedAt: input.updatedAt,
      };
      world.feedback[index] = record;
      return record;
    },
    async getFeedbackByTarget(input) {
      return world.feedback.find(
        (feedback) =>
          feedback.employeeId === input.employeeId &&
          feedback.threadId === input.threadId &&
          feedback.targetMessageId === input.targetMessageId,
      );
    },
    async listFeedback(input) {
      return world.feedback.filter((feedback) =>
        (!input?.employeeId || feedback.employeeId === input.employeeId) &&
        (!input?.threadId || feedback.threadId === input.threadId) &&
        (!input?.targetMessageId || feedback.targetMessageId === input.targetMessageId),
      );
    },
  };
}
