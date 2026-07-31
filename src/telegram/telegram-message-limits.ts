export const maxTelegramMessageCharacters = 4_000;

/** Telegram text limits are measured in UTF-16 code units. */
export function telegramMessageLength(text: string): number {
  return text.length;
}
