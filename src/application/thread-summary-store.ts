export type ThreadSummary = {
  employeeId: string;
  threadId: string;
  text: string;
  /** Inclusive message-id range covered by this regenerable checkpoint. */
  watermark: { fromMessageId: string; throughMessageId: string };
  updatedAt: string;
};

export type ThreadSummarySaveResult = "saved" | "conflict";

export type ThreadSummaryStore = {
  get(input: { employeeId: string; threadId: string }): Promise<ThreadSummary | undefined>;
  /** Compare-and-swap; undefined expects that no checkpoint exists yet. */
  save(summary: ThreadSummary, expectedThroughMessageId?: string): Promise<ThreadSummarySaveResult>;
};
