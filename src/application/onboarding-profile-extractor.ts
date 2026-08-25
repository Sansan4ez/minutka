import { normalizeIanaTimezone, resolveTimezoneAlias, resolveUtcOffsetTimezone } from "../shared/iana-timezone.js";
import type { OnboardingDraft, OnboardingProfileField, OnboardingProfilePatch } from "./onboarding-types.js";
import type { ModelTokenUsage } from "./usage-store.js";

/**
 * Extraction is a billed LLM call, so the adapter reports its own token usage
 * alongside the patch. `usage` is read by the caller before the patch is applied
 * and never reaches the onboarding draft.
 */
export type OnboardingProfileExtraction = OnboardingProfilePatch & { usage?: ModelTokenUsage };

export type OnboardingProfileExtractor = (input: {
  text: string;
  currentDraft: OnboardingDraft;
  /** The caller aborts slow provider work and keeps the current guided step. */
  signal?: AbortSignal;
}) => Promise<OnboardingProfileExtraction>;

const communicationStyleProtocol: ReadonlyMap<string, {
  addressForm: "informal" | "formal";
  persona: "support" | "efficiency";
}> = new Map([
  ["informal_support", { addressForm: "informal", persona: "support" }],
  ["formal_efficiency", { addressForm: "formal", persona: "efficiency" }],
  ["informal_efficiency", { addressForm: "informal", persona: "efficiency" }],
  ["formal_support", { addressForm: "formal", persona: "support" }],
]);

/**
 * Parses only values that belong to the guided transport protocol. It does not
 * interpret natural-language synonyms; those are owned by the structured LLM
 * extractor when a step explicitly allows free text.
 */
export function parseExactOnboardingAnswer(input: {
  text: string;
  currentDraft: OnboardingDraft;
}): OnboardingProfilePatch | undefined {
  const text = input.text.trim();
  if (!text) return undefined;

  if (input.currentDraft.pendingField === "preferredName") {
    const preferredName = normalizeLiteralName(text);
    return preferredName ? { preferredName, ambiguousFields: [] } : undefined;
  }

  const style: { addressForm: "informal" | "formal"; persona: "support" | "efficiency" } | undefined = communicationStyleProtocol.get(text);
  if (style) return { ...style, ambiguousFields: [] };

  const timezone = normalizeFormalTimezone(text);
  return timezone ? { timezone, ambiguousFields: [] } : undefined;
}

/** Accepts only formal timezone syntax used by callbacks and typed clients. */
export function normalizeFormalTimezone(value: string): string | undefined {
  return normalizeIanaTimezone(value) ?? resolveUtcOffsetTimezone(value);
}

/**
 * Normalizes a structured semantic extractor result before it reaches the draft.
 * Friendly city aliases are allowed here because the LLM, not this function,
 * decided that the text denotes a timezone.
 */
export function normalizeExtractedTimezone(value: string): string | undefined {
  return resolveTimezoneAlias(value) ?? normalizeIanaTimezone(value);
}

export function normalizeOnboardingProfilePatch(patch: OnboardingProfilePatch): OnboardingProfilePatch {
  const preferredName = patch.preferredName === undefined ? undefined : normalizeLiteralName(patch.preferredName);
  const assistantName = patch.assistantName === undefined ? undefined : normalizeLiteralName(patch.assistantName);
  const timezone = patch.timezone === undefined ? undefined : normalizeExtractedTimezone(patch.timezone);
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

export function emptyOnboardingPatch(): OnboardingProfilePatch {
  return { ambiguousFields: [] as OnboardingProfileField[] };
}

function normalizeLiteralName(value: string): string | undefined {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 128) return undefined;
  for (const character of cleaned) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return undefined;
  }
  return cleaned;
}
