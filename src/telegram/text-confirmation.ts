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

export type TextConfirmationSelection = { confirm: number[]; reject: number[] };
const ordinalValues: Readonly<Record<string, number>> = {
  "1": 1, "первое": 1, "первый": 1, "первую": 1,
  "2": 2, "второе": 2, "второй": 2, "вторую": 2,
  "3": 3, "третье": 3, "третий": 3, "третью": 3,
  "4": 4, "четвертое": 4, "четвёртое": 4, "четвертый": 4, "четвёртый": 4, "четвертую": 4, "четвёртую": 4,
  "5": 5, "пятое": 5, "пятый": 5, "пятую": 5,
};
const ordinalPattern = "(?:1|2|3|4|5|перв(?:ое|ый|ую)|втор(?:ое|ой|ую)|трет(?:ье|ий|ью)|четв(?:е|ё)рт(?:ое|ый|ую)|пят(?:ое|ый|ую))";

export function classifyTextConfirmationSelection(text: string, itemCount: number): TextConfirmationSelection | undefined {
  if (!Number.isSafeInteger(itemCount) || itemCount < 1 || itemCount > 5) return undefined;
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").trim();
  const whole = classifyTextConfirmation(normalized);
  if (whole) {
    const indices = Array.from({ length: itemCount }, (_, index) => index);
    return whole === "confirm" ? { confirm: indices, reject: [] } : { confirm: [], reject: indices };
  }
  const only = new RegExp(`^(?:только|лишь)\\s+(${ordinalPattern})[\\s.!?]*$`, "u").exec(normalized);
  if (only) {
    const index = ordinalIndex(only[1]!, itemCount);
    return index === undefined ? undefined : { confirm: [index], reject: [] };
  }
  const confirm = new Set<number>();
  const reject = new Set<number>();
  const segments = normalized.split(/[,;]+/u).map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return undefined;
  for (const segment of segments) {
    const decisionMatch = /(?:[-—:]\s*)?(да|нет|не\s+надо|подтверждаю|отклоняю)[.!?]*$/u.exec(segment);
    if (!decisionMatch) return undefined;
    const ordinalText = segment.slice(0, decisionMatch.index).replace(/(?:^|\s)(?:и|а)(?=\s|$)/gu, " ").replace(/[-—:]/gu, " ").trim();
    const ordinals = [...ordinalText.matchAll(new RegExp(ordinalPattern, "gu"))].map((match) => match[0]);
    const residue = ordinalText.replace(new RegExp(ordinalPattern, "gu"), " ").replace(/\s+/gu, " ").trim();
    if (!ordinals.length || residue) return undefined;
    for (const ordinal of ordinals) {
      const index = ordinalIndex(ordinal, itemCount);
      if (index === undefined || confirm.has(index) || reject.has(index)) return undefined;
      if (decisionMatch[1] === "да" || decisionMatch[1] === "подтверждаю") confirm.add(index); else reject.add(index);
    }
  }
  return { confirm: [...confirm].sort(), reject: [...reject].sort() };
}

function ordinalIndex(value: string, itemCount: number): number | undefined {
  const normalized = value.replace(/ё/gu, "е");
  const ordinal = ordinalValues[normalized];
  if (!ordinal || ordinal > itemCount) return undefined;
  return ordinal - 1;
}
