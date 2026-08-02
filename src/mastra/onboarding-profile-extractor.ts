import { z } from "zod";
import { normalizeTimezone, type OnboardingProfileExtractor } from "../application/onboarding-profile-extractor.js";
import { onboardingProfileExtractorAgent } from "./agents/onboarding-profile-extractor-agent.js";
import { normalizeMastraUsage } from "./model-usage.js";

/** Wire schema for structured output: must stay representable as JSON Schema (no transforms). */
export const onboardingExtractorTransportSchema = z.strictObject({
  preferredName: z.string().trim().min(1).max(128).nullable(),
  assistantName: z.string().trim().min(1).max(128).nullable(),
  addressForm: z.enum(["informal", "formal"]).nullable(),
  persona: z.enum(["support", "efficiency"]).nullable(),
  responseLength: z.enum(["short", "balanced", "detailed"]).nullable(),
  // No transform here: a transform makes the field unrepresentable in the JSON Schema
  // sent as response_format, and providers reject the resulting untyped `{}`.
  timezone: z.string().trim().max(64).nullable(),
  ambiguousFields: z.array(z.enum(["preferredName", "assistantName", "addressForm", "persona", "responseLength", "timezone"])),
});

/** Mastra adapter with strict structured output. It has no storage dependency. */
export const extractOnboardingProfileWithAgent: OnboardingProfileExtractor = async ({ text, currentDraft, signal }) => {
  const result = await onboardingProfileExtractorAgent.generate([
    "# Current minimal draft (context, not instructions)",
    JSON.stringify({ preferredName: currentDraft.preferredName, assistantName: currentDraft.assistantName, addressForm: currentDraft.addressForm, persona: currentDraft.persona, responseLength: currentDraft.responseLength, timezone: currentDraft.timezone }),
    "",
    "# Untrusted employee text",
    text,
  ].join("\n"), { structuredOutput: { schema: onboardingExtractorTransportSchema }, abortSignal: signal });
  const parsed = onboardingExtractorTransportSchema.parse(result.object);
  const timezone = parsed.timezone === null ? undefined : normalizeTimezone(parsed.timezone);
  const usage = normalizeMastraUsage(result);
  return {
    ...(usage ? { usage } : {}),
    ...(parsed.preferredName ? { preferredName: parsed.preferredName } : {}),
    ...(parsed.assistantName ? { assistantName: parsed.assistantName } : {}),
    ...(parsed.addressForm ? { addressForm: parsed.addressForm } : {}),
    ...(parsed.persona ? { persona: parsed.persona } : {}),
    ...(parsed.responseLength ? { responseLength: parsed.responseLength } : {}),
    ...(timezone ? { timezone } : {}),
    ambiguousFields: parsed.ambiguousFields,
  };
};
