import type { AddressForm, Persona, ResponseLengthPreference } from "../domain/employee.js";
import { normalizeIanaTimezone, resolveTimezoneAlias } from "../shared/iana-timezone.js";
import type { OnboardingDraft, OnboardingProfileField, OnboardingProfilePatch } from "./onboarding-types.js";
import type { ModelTokenUsage } from "./usage-store.js";

/**
 * Extraction is a billed LLM call, so the adapter reports its own token usage
 * alongside the patch. `usage` is read by the caller before the patch is merged
 * and never reaches the onboarding draft.
 */
export type OnboardingProfileExtraction = OnboardingProfilePatch & { usage?: ModelTokenUsage };

export type OnboardingProfileExtractor = (input: {
  text: string;
  currentDraft: OnboardingDraft;
  /** The caller aborts slow provider work before falling back deterministically. */
  signal?: AbortSignal;
}) => Promise<OnboardingProfileExtraction>;

/**
 * Conservative, dependency-free extraction used both as the reliable fallback
 * and by executable specs. It only emits bounded values with explicit signals.
 */
export function extractDeterministicOnboardingPatch(input: {
  text: string;
  currentDraft: OnboardingDraft;
}): OnboardingProfilePatch {
  const text = input.text.trim();
  const patch: OnboardingProfilePatch = { ambiguousFields: [] };

  const pipe = text.split("|").map((part) => part.trim());
  if (pipe.length === 6 && pipe.every(Boolean)) {
    patch.preferredName = cleanName(pipe[0]);
    patch.assistantName = cleanName(pipe[1]);
    patch.addressForm = addressForm(pipe[2]);
    patch.persona = persona(pipe[3]);
    patch.responseLength = responseLength(pipe[4]);
    patch.timezone = normalizeTimezone(pipe[5]);
    return normalizeOnboardingProfilePatch(patch);
  }
  if (pipe.length === 3 && pipe.every(Boolean)) {
    patch.preferredName = cleanName(pipe[0]);
    patch.addressForm = addressForm(pipe[1]);
    patch.persona = persona(pipe[1]);
    patch.timezone = normalizeTimezone(pipe[2]);
    return normalizeOnboardingProfilePatch(patch);
  }

  patch.preferredName = capture(text, /(?:меня зовут|зови(?:те)? меня|обращай(?:ся|тесь) ко мне|мо[её] имя)\s*[-—:]?\s*([^.;|\n]+)/iu);
  patch.assistantName = capture(text, /(?:тебя зовут|буду звать тебя|назову тебя|имя ассистента|ассистента зовут)\s*[-—:]?\s*([^.;|\n]+)/iu);
  patch.addressForm = addressForm(text) ?? communicationStylePreset(text)?.addressForm;
  patch.persona = persona(text) ?? communicationStylePreset(text)?.persona;
  patch.responseLength = responseLengthFromMessage(text);
  patch.timezone = extractTimezone(text);

  const pending = input.currentDraft.pendingField;
  if (pending === "roleId") return normalizeOnboardingProfilePatch(patch);
  if (pending === "preferredName" && !patch.preferredName) patch.preferredName = cleanName(text);
  if (pending === "communicationStyle") {
    const preset = communicationStylePreset(text);
    if (!patch.addressForm) patch.addressForm = addressForm(text) ?? preset?.addressForm;
    if (!patch.persona) patch.persona = persona(text) ?? preset?.persona;
  }
  if (pending === "timezone" && !patch.timezone) patch.timezone = normalizeTimezone(text);

  return normalizeOnboardingProfilePatch(patch);
}

export function normalizePersona(value: string): Persona | undefined {
  const text = normalize(value);
  if (hasBoundedSignal(text, /(?:support|поддержк\p{L}*|бережн\p{L}*|тепл\p{L}*|эмпатичн\p{L}*|по человечески)/u)) return "support";
  if (hasBoundedSignal(text, /(?:efficiency|эффективност\p{L}*|по делу|делов\p{L}*|коротко и практично|структурн\p{L}*)/u)) return "efficiency";
  return undefined;
}

export function normalizeResponseLength(value: string): ResponseLengthPreference | undefined {
  const text = normalize(value);
  if (hasBoundedSignal(text, /(?:short|кратк\p{L}*|коротк\p{L}*|лаконичн\p{L}*)/u)) return "short";
  if (hasBoundedSignal(text, /(?:detailed|подробн\p{L}*|детальн\p{L}*|разв[её]рнут\p{L}*)/u)) return "detailed";
  if (hasBoundedSignal(text, /(?:balanced|сбалансированн\p{L}*|средн\p{L}*|обычн\p{L}*)/u)) return "balanced";
  return undefined;
}

export function normalizeAddressForm(value: string): AddressForm | undefined {
  const text = normalize(value);
  if (hasBoundedSignal(text, /(?:informal|на ты|обращайся на ты|тыкай)/u)) return "informal";
  if (hasBoundedSignal(text, /(?:formal|на вы|обращайтесь на вы)/u)) return "formal";
  return undefined;
}

export function normalizeTimezone(value: string): string | undefined {
  const candidate = value.trim().replace(/[.,;!?]+$/u, "");
  return resolveTimezoneAlias(candidate) ?? normalizeIanaTimezone(candidate);
}

function communicationStylePreset(value: string): { addressForm: AddressForm; persona: Persona } | undefined {
  const text = normalize(value).replace(/[_-]/gu, " ");
  if (text === "informal support" || text.includes("на ты, по человечески")) return { addressForm: "informal", persona: "support" };
  if (text === "formal efficiency" || text.includes("на вы, по деловому")) return { addressForm: "formal", persona: "efficiency" };
  if (text === "informal efficiency" || text.includes("на ты, коротко и по делу")) return { addressForm: "informal", persona: "efficiency" };
  if (text === "formal support" || text.includes("на вы, по человечески")) return { addressForm: "formal", persona: "support" };
  return undefined;
}
function addressForm(value: string): AddressForm | undefined { return normalizeAddressForm(value); }
function persona(value: string): Persona | undefined { return normalizePersona(value); }
function responseLength(value: string): ResponseLengthPreference | undefined { return normalizeResponseLength(value); }
function responseLengthFromMessage(value: string): ResponseLengthPreference | undefined {
  const text = normalize(value);
  const result = normalizeResponseLength(text);
  if (result !== "balanced") return result;
  return hasBoundedSignal(text, /(?:balanced|сбалансированн\p{L}*|средн\p{L}*|обычн\p{L}*\s+(?:длин\p{L}*|ответ\p{L}*))/u) ? result : undefined;
}
function normalize(value: string): string { return value.toLocaleLowerCase("ru-RU").replace(/[«»"']/g, " ").replace(/\s+/g, " ").trim(); }
function hasBoundedSignal(value: string, signal: RegExp): boolean {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${signal.source})(?=$|[^\\p{L}\\p{N}_])`, "u").test(value);
}
function capture(value: string, pattern: RegExp): string | undefined { const match = value.match(pattern); return match?.[1] ? cleanName(match[1]) : undefined; }
function cleanName(value: string): string | undefined {
  const cleaned = value.trim().replace(/^(?:меня зовут|зови(?:те)? меня|обращай(?:ся|тесь) ко мне|тебя зовут|буду звать тебя|назову тебя)\s*[-—:]?\s*/iu, "").trim();
  return cleaned && cleaned.length <= 128 ? cleaned : undefined;
}
function extractTimezone(value: string): string | undefined {
  const explicit = value.match(/(?:timezone|часов(?:ой|ого) пояс)\s*[-—:]?\s*([^.;|\n]+)/iu)?.[1];
  if (explicit) return normalizeTimezone(explicit);
  const standaloneIana = value.match(/\b([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*)\b/gu)?.find((candidate) => normalizeTimezone(candidate) !== undefined);
  if (standaloneIana) return normalizeTimezone(standaloneIana);
  return resolveTimezoneAlias(value);
}
export function normalizeOnboardingProfilePatch(patch: OnboardingProfilePatch): OnboardingProfilePatch {
  const preferredName = patch.preferredName === undefined ? undefined : cleanName(patch.preferredName);
  const assistantName = patch.assistantName === undefined ? undefined : cleanName(patch.assistantName);
  const timezone = patch.timezone === undefined ? undefined : normalizeTimezone(patch.timezone);
  return {
    ...(preferredName ? { preferredName } : {}),
    ...(assistantName ? { assistantName } : {}),
    ...(patch.addressForm ? { addressForm: patch.addressForm } : {}),
    ...(patch.persona ? { persona: patch.persona } : {}),
    ...(patch.responseLength ? { responseLength: patch.responseLength } : {}),
    ...(timezone ? { timezone } : {}),
    ambiguousFields: [...new Set(patch.ambiguousFields)],
  };
}

export function emptyOnboardingPatch(): OnboardingProfilePatch { return { ambiguousFields: [] as OnboardingProfileField[] }; }
