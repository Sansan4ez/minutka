import { z } from "zod";
import { normalizeTimezone, type OnboardingProfileExtractor } from "../application/onboarding-profile-extractor.js";
import { onboardingProfileExtractorAgent } from "./agents/onboarding-profile-extractor-agent.js";

const transportSchema = z.strictObject({
  preferredName: z.string().trim().min(1).max(128).nullable(),
  assistantName: z.string().trim().min(1).max(128).nullable(),
  addressForm: z.enum(["informal", "formal"]).nullable(),
  persona: z.enum(["support", "efficiency"]).nullable(),
  responseLength: z.enum(["short", "balanced", "detailed"]).nullable(),
  timezone: z.string().trim().max(64).transform((value, context) => {
    const timezone = normalizeTimezone(value);
    if (timezone) return timezone;
    context.addIssue({ code: "custom", message: "Invalid IANA timezone" });
    return z.NEVER;
  }).nullable(),
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
  ].join("\n"), { structuredOutput: { schema: transportSchema }, abortSignal: signal });
  const parsed = transportSchema.parse(result.object);
  return {
    ...(parsed.preferredName ? { preferredName: parsed.preferredName } : {}),
    ...(parsed.assistantName ? { assistantName: parsed.assistantName } : {}),
    ...(parsed.addressForm ? { addressForm: parsed.addressForm } : {}),
    ...(parsed.persona ? { persona: parsed.persona } : {}),
    ...(parsed.responseLength ? { responseLength: parsed.responseLength } : {}),
    ...(parsed.timezone ? { timezone: parsed.timezone } : {}),
    ambiguousFields: parsed.ambiguousFields,
  };
};
