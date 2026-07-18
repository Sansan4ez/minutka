/** Maximum Unicode code points accepted for one assistant chat request. */
export const maxChatInputCharacters = 4_096;

/** Counts Unicode code points rather than JavaScript UTF-16 code units. */
export function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length;
}

export function chatInputFitsCharacterLimit(value: string): boolean {
  return countUnicodeCodePoints(value) <= maxChatInputCharacters;
}
