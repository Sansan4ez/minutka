import type { ChannelSource } from "./channel-source.js";

export type FeedbackRating = "positive" | "neutral" | "negative";
export type FeedbackSource = ChannelSource;

export type FeedbackRecord = {
  id: string;
  employeeId: string;
  threadId: string;
  targetMessageId: string;
  rating: FeedbackRating;
  createdAt: string;
  updatedAt: string;
  source: FeedbackSource;
};
