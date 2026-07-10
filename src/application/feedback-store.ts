import type { FeedbackRecord } from "../domain/feedback.js";

export type SaveFeedbackInput = Omit<FeedbackRecord, "id" | "createdAt">;

export interface FeedbackStore {
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
