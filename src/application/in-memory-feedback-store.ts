import type { FeedbackRecord } from "../domain/feedback.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { FeedbackStore, SaveFeedbackInput } from "./feedback-store.js";

export function createInMemoryFeedbackStore(world: InMemoryWorld): FeedbackStore {
  return {
    async saveFeedback(input: SaveFeedbackInput): Promise<FeedbackRecord> {
      const index = world.feedback.findIndex(
        (f) =>
          f.employeeId === input.employeeId &&
          f.threadId === input.threadId &&
          f.targetMessageId === input.targetMessageId
      );

      let record: FeedbackRecord;
      if (index === -1) {
        world.counters.feedback++;
        record = {
          ...input,
          id: `fb_${world.counters.feedback}`,
          createdAt: world.now(),
        };
        world.feedback.push(record);
      } else {
        const existing = world.feedback[index];
        record = {
          ...existing,
          rating: input.rating,
          source: input.source,
        };
        world.feedback[index] = record;
      }
      return record;
    },

    async getFeedbackByTarget(input: {
      employeeId: string;
      threadId: string;
      targetMessageId: string;
    }): Promise<FeedbackRecord | undefined> {
      return world.feedback.find(
        (f) =>
          f.employeeId === input.employeeId &&
          f.threadId === input.threadId &&
          f.targetMessageId === input.targetMessageId
      );
    },

    async listFeedback(input?: {
      employeeId?: string;
      threadId?: string;
      targetMessageId?: string;
    }): Promise<FeedbackRecord[]> {
      return world.feedback.filter((f) => {
        if (input?.employeeId && f.employeeId !== input.employeeId) return false;
        if (input?.threadId && f.threadId !== input.threadId) return false;
        if (input?.targetMessageId && f.targetMessageId !== input.targetMessageId) return false;
        return true;
      });
    }
  };
}
