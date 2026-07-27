import type { ConversationTurn } from "./conversation-store.js";
import { renderedThreadSummaryCharacters } from "./runtime-projections/runtime-projection-renderer.js";
import type { ThreadSummary } from "./thread-summary-store.js";

export const threadSummarySectionHeadings = [
  "Факты",
  "Решения",
  "Договорённости",
  "Открытые вопросы",
] as const;

export const threadSummaryReductionMarker = "- История сокращена для лимита.";

export const minimumThreadSummaryText = [
  `## ${threadSummarySectionHeadings[0]}`,
  threadSummaryReductionMarker,
  ...threadSummarySectionHeadings.slice(1).map((heading) => `## ${heading}`),
].join("\n");

export const canonicalThreadSummaryWatermark = {
  fromMessageId: "msg_00000000-0000-0000-0000-000000000000",
  throughMessageId: "msg_00000000-0000-0000-0000-000000000000",
} as const;

export const minimumThreadSummaryCharacters = renderedThreadSummaryCharacters({
  employeeId: "owner",
  threadId: "thread",
  text: minimumThreadSummaryText,
  watermark: canonicalThreadSummaryWatermark,
  updatedAt: "1970-01-01T00:00:00.000Z",
});

export type ThreadSummaryInput = {
  previous?: ThreadSummary;
  turns: ConversationTurn[];
  ceiling: number;
  fieldCharacters: number;
};

/** Pure derivation boundary: it receives text and returns text, with no store capabilities. */
export type ThreadSummarizer = (input: ThreadSummaryInput) => Promise<{ text: string }>;
