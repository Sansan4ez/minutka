export type ThreadSummary = {
  employeeId: string;
  threadId: string;
  text: string;
  /** Inclusive message-id range covered by this regenerable checkpoint. */
  watermark: { fromMessageId: string; throughMessageId: string };
  updatedAt: string;
};

export type ThreadSummaryStore = {
  get(input: { employeeId: string; threadId: string }): Promise<ThreadSummary | undefined>;
  save(summary: ThreadSummary): Promise<void>;
};
