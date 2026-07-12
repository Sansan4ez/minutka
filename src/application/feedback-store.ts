import type { FeedbackRecord } from "../domain/feedback.js";

export type SaveFeedbackInput = Omit<FeedbackRecord, "createdAt"> & { updatedAt: string };

export interface FeedbackStore {
  /** Upserts by employee/thread/target. Existing id and createdAt remain stable. */
  saveFeedback(input: SaveFeedbackInput): Promise<FeedbackRecord>;
  getFeedbackByTarget(input: {
    employeeId: string;
    threadId: string;
    targetMessageId: string;
  }): Promise<FeedbackRecord | undefined>;
  listFeedback(input?: {
    employeeId?: string;
    threadId?: string;
    targetMessageId?: string;
  }): Promise<FeedbackRecord[]>;
}
