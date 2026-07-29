/** Maximum Unicode code points accepted for one assistant chat request. */
export const maxChatInputCharacters = 4_096;

/** Maximum Unicode code points exposed in a pending task action summary. */
export const pendingTaskSummaryMaximumCodePoints = 280;

/** Counts Unicode code points rather than JavaScript UTF-16 code units. */
export function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length;
}

export function chatInputFitsCharacterLimit(value: string): boolean {
  return countUnicodeCodePoints(value) <= maxChatInputCharacters;
}
