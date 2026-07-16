import type { AddressForm, Persona, ResponseLengthPreference } from "../domain/employee.js";
import type { OnboardingDraft, OnboardingField, OnboardingProfilePatch } from "./onboarding-types.js";

export type OnboardingProfileExtractor = (input: {
  text: string;
  currentDraft: OnboardingDraft;
  /** The caller aborts slow provider work before falling back deterministically. */
  signal?: AbortSignal;
}) => Promise<OnboardingProfilePatch>;

/**
 * Conservative, dependency-free extraction used both as the reliable fallback
 * and by executable specs. It only emits bounded values with explicit signals.
 */
export function extractDeterministicOnboardingPatch(input: {
  text: string;
  currentDraft: OnboardingDraft;
}): OnboardingProfilePatch {
  const text = input.text.trim();
  const normalized = normalize(text);
  const patch: OnboardingProfilePatch = { ambiguousFields: [] };

  const pipe = text.split("|").map((part) => part.trim());
  if (pipe.length === 6 && pipe.every(Boolean)) {
    patch.preferredName = cleanName(pipe[0]);
    patch.assistantName = cleanName(pipe[1]);
    patch.addressForm = addressForm(pipe[2]);
    patch.persona = persona(pipe[3]);
    patch.responseLength = responseLength(pipe[4]);
    patch.timezone = normalizeTimezone(pipe[5]);
    return validatePatch(patch);
  }

  patch.preferredName = capture(text, /(?:меня зовут|зови(?:те)? меня|обращай(?:ся|тесь) ко мне|мо[её] имя)\s*[-—:]?\s*([^.;|\n]+)/iu);
  patch.assistantName = capture(text, /(?:тебя зовут|буду звать тебя|назову тебя|имя ассистента|ассистента зовут)\s*[-—:]?\s*([^.;|\n]+)/iu);
  patch.addressForm = addressForm(normalized);
  patch.persona = persona(normalized);
  patch.responseLength = responseLength(normalized);
  patch.timezone = extractTimezone(text);

  const pending = input.currentDraft.pendingField;
  if (pending === "preferredName" && !patch.preferredName) patch.preferredName = cleanName(text);
  if (pending === "assistantName" && !patch.assistantName) patch.assistantName = cleanName(text);
  if (pending === "addressForm" && !patch.addressForm) patch.addressForm = addressForm(text);
  if (pending === "persona" && !patch.persona) patch.persona = persona(text);
  if (pending === "responseLength" && !patch.responseLength) patch.responseLength = responseLength(text);
  if (pending === "timezone" && !patch.timezone) patch.timezone = normalizeTimezone(text);

  return validatePatch(patch);
}

export function normalizePersona(value: string): Persona | undefined {
  const text = normalize(value);
  if (/(?:support|поддержк\w*|бережн\w*|тепл\w*|эмпатичн\w*)/u.test(text)) return "support";
  if (/(?:efficiency|эффективност\w*|по делу|делов\w*|коротко и практично|структурн\w*)/u.test(text)) return "efficiency";
  return undefined;
}

export function normalizeResponseLength(value: string): ResponseLengthPreference | undefined {
  const text = normalize(value);
  if (/(?:short|кратк\w*|коротк\w*|лаконичн\w*)/u.test(text)) return "short";
  if (/(?:detailed|подробн\w*|детальн\w*|разв[её]рнут\w*)/u.test(text)) return "detailed";
  if (/(?:balanced|сбалансированн\w*|средн\w*|обычн\w*)/u.test(text)) return "balanced";
  return undefined;
}

export function normalizeAddressForm(value: string): AddressForm | undefined {
  const text = normalize(value);
  if (/(?:informal|на ты|обращайся на ты|тыкай)/u.test(text)) return "informal";
  if (/(?:formal|на вы|обращайтесь на вы)/u.test(text)) return "formal";
  return undefined;
}

export function normalizeTimezone(value: string): string | undefined {
  const candidate = value.trim().replace(/[.,;!?]+$/u, "");
  if (!candidate || candidate.length > 64 || !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u.test(candidate)) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return undefined;
  }
}

function addressForm(value: string): AddressForm | undefined { return normalizeAddressForm(value); }
function persona(value: string): Persona | undefined { return normalizePersona(value); }
function responseLength(value: string): ResponseLengthPreference | undefined { return normalizeResponseLength(value); }
function normalize(value: string): string { return value.toLocaleLowerCase("ru-RU").replace(/[«»"']/g, " ").replace(/\s+/g, " ").trim(); }
function capture(value: string, pattern: RegExp): string | undefined { const match = value.match(pattern); return match?.[1] ? cleanName(match[1]) : undefined; }
function cleanName(value: string): string | undefined {
  const cleaned = value.trim().replace(/^(?:меня зовут|зови(?:те)? меня|обращай(?:ся|тесь) ко мне|тебя зовут|буду звать тебя|назову тебя)\s*[-—:]?\s*/iu, "").trim();
  return cleaned && cleaned.length <= 128 ? cleaned : undefined;
}
function extractTimezone(value: string): string | undefined {
  const explicit = value.match(/(?:timezone|часов(?:ой|ого) пояс)\s*[-—:]?\s*([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)/iu)?.[1];
  if (explicit) return normalizeTimezone(explicit);
  const standalone = value.match(/\b([A-Za-z_+-]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)\b/u)?.[1];
  return standalone ? normalizeTimezone(standalone) : undefined;
}
function validatePatch(patch: OnboardingProfilePatch): OnboardingProfilePatch {
  if (patch.preferredName && !cleanName(patch.preferredName)) delete patch.preferredName;
  if (patch.assistantName && !cleanName(patch.assistantName)) delete patch.assistantName;
  if (patch.timezone && !normalizeTimezone(patch.timezone)) delete patch.timezone;
  return patch;
}

export function emptyOnboardingPatch(): OnboardingProfilePatch { return { ambiguousFields: [] as OnboardingField[] }; }
