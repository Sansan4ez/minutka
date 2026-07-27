import type { ConversationTurn } from "./conversation-store.js";
import type { ThreadSummary } from "./thread-summary-store.js";

export const threadSummarySectionHeadings = [
  "Факты",
  "Решения",
  "Договорённости",
  "Открытые вопросы",
] as const;

export const threadSummaryReductionMarker = "- История сокращена для лимита.";

export const minimumThreadSummaryCharacters = Array.from([
  `## ${threadSummarySectionHeadings[0]}`,
  threadSummaryReductionMarker,
  ...threadSummarySectionHeadings.slice(1).map((heading) => `## ${heading}`),
].join("\n")).length;

export type ThreadSummaryInput = {
  previous?: ThreadSummary;
  turns: ConversationTurn[];
  ceiling: number;
  fieldCharacters: number;
};

/** Pure derivation boundary: it receives text and returns text, with no store capabilities. */
export type ThreadSummarizer = (input: ThreadSummaryInput) => Promise<{ text: string }>;
