import type { ConversationTurn } from "./conversation-store.js";
import type { ThreadSummary } from "./thread-summary-store.js";

export const threadSummarySectionHeadings = [
  "Факты",
  "Решения",
  "Договорённости",
  "Открытые вопросы",
] as const;

export type ThreadSummaryInput = {
  previous?: ThreadSummary;
  turns: ConversationTurn[];
  ceiling: number;
  /** True when the previous generation exceeded the ceiling and must be compressed again. */
  reduce: boolean;
};

/** Pure derivation boundary: it receives text and returns text, with no store capabilities. */
export type ThreadSummarizer = (input: ThreadSummaryInput) => Promise<{ text: string }>;
