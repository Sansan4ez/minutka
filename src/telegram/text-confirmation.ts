export type TextConfirmationDecision = "confirm" | "reject";

const confirmationPhrases = new Set([
  "да",
  "ок",
  "давай",
  "подтверждаю",
  "согласен",
  "ага",
  "угу",
  "yes",
  "confirm",
]);

const rejectionPhrases = new Set([
  "нет",
  "не надо",
  "отмена",
  "отклоняю",
  "стоп",
]);

const maximumDecisionCharacters = 24;
const leadingPunctuation = /^[\s.,!?;:…—–-]*/u;
const trailingPunctuation = /[\s.,!?;:…—–-]*$/u;

export function classifyTextConfirmation(text: string): TextConfirmationDecision | undefined {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
  if (!normalized || Array.from(normalized).length > maximumDecisionCharacters) return undefined;
  const phrase = normalized.replace(leadingPunctuation, "").replace(trailingPunctuation, "").trim();
  if (!phrase || /\p{Extended_Pictographic}/u.test(phrase)) return undefined;
  if (confirmationPhrases.has(phrase)) return "confirm";
  if (rejectionPhrases.has(phrase)) return "reject";
  return undefined;
}
