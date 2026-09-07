import { z } from "zod";
import { activityRecurrenceValues, collectActivitiesMaximumItems } from "../contracts/minutka-activity.js";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  taskCategories,
} from "../domain/insights.js";
import { MAX_DURATION_REFERENCES } from "./activity-duration-evidence.js";
import type { ModelTokenUsage } from "./usage-store.js";

export const activityTransactionModes = ["record", "repair"] as const;
export type ActivityTransactionMode = typeof activityTransactionModes[number];

export const activityTransactionClarificationReasons = [
  "activity_status_ambiguous",
  "correction_target_ambiguous",
  "duplicate_pair_ambiguous",
  "repair_target_not_found",
] as const;
export type ActivityTransactionClarificationReason = typeof activityTransactionClarificationReasons[number];

export const activityTransactionFailureCodes = [
  "context_budget_error",
  "provider_error",
  "schema_error",
] as const;
export type ActivityTransactionFailureCode = typeof activityTransactionFailureCodes[number];

const boundedHandleSchema = z.string().trim().min(1).max(160);
const boundedTimestampSchema = z.string().trim().min(1).max(64);
const durationReferenceSchema = z.strictObject({
  ref: z.string().trim().min(1).max(64),
  bucket: z.enum(activityDurationBuckets),
  sourceOrder: z.number().int().nonnegative(),
});

/** Closed extractor patch. Unknown facets are omitted, never represented by guessed defaults. */
export const activityTransactionPatchSchema = z.strictObject({
  taskCategory: z.enum(taskCategories).optional(),
  routinePattern: z.enum(routinePatternTypes).optional(),
  automationCandidate: z.enum(automationCandidateTypes).optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes).optional(),
  system: z.enum(activitySystems).optional(),
  routineId: z.string().trim().min(1).max(64).nullable().optional(),
  routineLabel: z.string().trim().min(3).max(80).nullable().optional(),
  recurrence: z.enum(activityRecurrenceValues).nullable().optional(),
  durationRef: z.string().trim().min(1).max(64).optional(),
});
export type ActivityTransactionPatch = z.infer<typeof activityTransactionPatchSchema>;

const nonEmptyActivityTransactionPatchSchema = activityTransactionPatchSchema.refine(
  (patch) => Object.keys(patch).length > 0,
  "activity transaction patch must contain at least one evidenced facet",
);

export const activityTransactionRecentCandidateSchema = z.strictObject({
  handle: boundedHandleSchema,
  revision: z.number().int().min(1),
  taskCategory: z.enum(taskCategories).optional(),
  routinePattern: z.enum(routinePatternTypes).optional(),
  automationCandidate: z.enum(automationCandidateTypes).optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes).optional(),
  durationBucket: z.enum(activityDurationBuckets).optional(),
  system: z.enum(activitySystems).optional(),
  activityDate: boundedTimestampSchema,
  recordedAt: boundedTimestampSchema,
});
export type ActivityTransactionRecentCandidate = z.infer<typeof activityTransactionRecentCandidateSchema>;

const activityTransactionInputBase = {
  currentText: z.string().trim().min(1),
  durationReferences: z.array(durationReferenceSchema).max(MAX_DURATION_REFERENCES),
  signal: z.custom<AbortSignal>().optional(),
};

/** Record mode cannot carry history; repair mode can see at most five closed candidates. */
export const activityTransactionExtractorInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("record"),
    ...activityTransactionInputBase,
  }),
  z.strictObject({
    mode: z.literal("repair"),
    ...activityTransactionInputBase,
    recentCandidates: z.array(activityTransactionRecentCandidateSchema).max(5),
  }),
]);
export type ActivityTransactionExtractorInput = z.infer<typeof activityTransactionExtractorInputSchema>;

export const activityTransactionDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("none"),
    reason: z.literal("no_factual_activity"),
  }),
  z.strictObject({
    kind: z.literal("needs_clarification"),
    reason: z.enum(activityTransactionClarificationReasons),
  }),
  z.strictObject({
    kind: z.literal("collect"),
    activities: z.array(nonEmptyActivityTransactionPatchSchema).min(1).max(collectActivitiesMaximumItems),
  }),
  z.strictObject({
    kind: z.literal("correct"),
    handle: boundedHandleSchema,
    expectedRevision: z.number().int().min(1),
    mode: z.enum(["patch", "replace"]),
    correction: nonEmptyActivityTransactionPatchSchema,
  }),
  z.strictObject({
    kind: z.literal("supersede"),
    handle: boundedHandleSchema,
    expectedRevision: z.number().int().min(1),
    replacementHandle: boundedHandleSchema,
    replacementExpectedRevision: z.number().int().min(1),
  }).refine((decision) => decision.handle !== decision.replacementHandle, "supersession handles must differ"),
]);
export type ActivityTransactionDecision = z.infer<typeof activityTransactionDecisionSchema>;

const nullablePatchBase = {
  taskCategory: z.enum(taskCategories)
    .describe("Category supported by the current employee message; null only when the factual work cannot be classified.")
    .nullable(),
  routinePattern: z.enum(routinePatternTypes)
    .describe("Workflow friction explicitly stated for this activity in the current employee message. null when unstated. Repetition alone is not routine evidence; other requires explicit friction outside the taxonomy.")
    .nullable(),
  automationCandidate: z.enum(automationCandidateTypes)
    .describe("Automation opportunity explicitly stated for this activity in the current employee message. null when unstated. Performing repeated work or preparing a template/checklist is not by itself automation evidence; other requires an explicit outside-taxonomy opportunity.")
    .nullable(),
  energyStressMarker: z.enum(energyStressMarkerTypes)
    .describe("Work-related energy or stress signal explicitly stated for this activity in the current employee message. null when unstated; neutral is never a default.")
    .nullable(),
  system: z.enum(activitySystems)
    .describe("Generic system or channel explicitly named or unambiguously typed in the current employee message. null when unstated. paper_or_verbal requires explicit paper or verbal evidence; other requires an explicit known outside-taxonomy system type.")
    .nullable(),
  routineId: z.string().trim().min(1).max(64)
    .describe("Routine directory id explicitly supported by the current employee message or existing activity correction evidence. null when unstated or when no directory entry applies.")
    .nullable(),
  routineLabel: z.string().trim().min(3).max(80)
    .describe("Routine label explicitly supported by the current employee message or correction evidence, containing only the work object and action. null when unstated.")
    .nullable(),
  recurrence: z.enum(activityRecurrenceValues)
    .describe("Recurrence explicitly stated by the current employee message or correction evidence. null when unstated.")
    .nullable(),
};

/**
 * Provider-safe flat transport. Every branch field is present and nullable;
 * pure normalization below recovers the strict transport-neutral union and
 * rejects impossible cross-branch field combinations.
 */
export function createActivityTransactionTransportSchema(durationRefs: readonly string[]) {
  const uniqueRefs = [...new Set(durationRefs)];
  const durationRef = uniqueRefs.length === 0
    ? z.null()
    : z.enum(uniqueRefs as [string, ...string[]]).nullable();
  const patch = z.strictObject({ ...nullablePatchBase, durationRef });
  return z.strictObject({
    kind: z.enum(["none", "needs_clarification", "collect", "correct", "supersede"]),
    reason: z.enum(["no_factual_activity", ...activityTransactionClarificationReasons]).nullable(),
    activities: z.array(patch).max(collectActivitiesMaximumItems),
    handle: boundedHandleSchema.nullable(),
    expectedRevision: z.number().int().min(1).nullable(),
    correctionMode: z.enum(["patch", "replace"]).nullable(),
    correction: patch.nullable(),
    replacementHandle: boundedHandleSchema.nullable(),
    replacementExpectedRevision: z.number().int().min(1).nullable(),
  });
}

export type ActivityTransactionTransport = z.infer<ReturnType<typeof createActivityTransactionTransportSchema>>;

export type ActivityTransactionContextMeasurement = {
  currentTextCharacters: number;
  staticRulesCharacters: number;
  durationReferencesCharacters: number;
  recentCandidatesCharacters: number;
  promptCharacters: number;
};

export type ActivityTransactionGenerationTrace = {
  promptVersion: string;
  model: string;
  boundedContext: string;
  modelSteps: unknown[];
  latencyMs: number;
};

export type ActivityTransactionExtractionResult =
  | {
    status: "completed";
    decision: ActivityTransactionDecision;
    context: ActivityTransactionContextMeasurement;
    usage?: ModelTokenUsage;
    trace?: ActivityTransactionGenerationTrace;
  }
  | {
    status: "failed";
    code: ActivityTransactionFailureCode;
    context?: ActivityTransactionContextMeasurement;
    usage?: ModelTokenUsage;
    trace?: ActivityTransactionGenerationTrace;
  };

export type ActivityTransactionExtractor = (
  input: ActivityTransactionExtractorInput,
) => Promise<ActivityTransactionExtractionResult>;

export type ActivityTransactionGeneration = {
  object?: unknown;
  usage?: ModelTokenUsage;
  trace?: ActivityTransactionGenerationTrace;
};

export type ActivityTransactionGenerator = (input: {
  prompt: string;
  outputSchema: ReturnType<typeof createActivityTransactionTransportSchema>;
  signal?: AbortSignal;
}) => Promise<ActivityTransactionGeneration>;

export type ActivityTransactionPromptBuilder = (input: ActivityTransactionExtractorInput) => {
  prompt: string;
  context: ActivityTransactionContextMeasurement;
};

/** One generation, one validation pass, and no deterministic semantic fallback. */
export function createActivityTransactionExtractor(
  generate: ActivityTransactionGenerator,
  buildPrompt: ActivityTransactionPromptBuilder,
): ActivityTransactionExtractor {
  return async (input) => {
    const parsedInput = activityTransactionExtractorInputSchema.parse(input);
    let built: ReturnType<ActivityTransactionPromptBuilder>;
    try {
      built = buildPrompt(parsedInput);
    } catch {
      return { status: "failed", code: "context_budget_error" };
    }

    let generated: ActivityTransactionGeneration;
    try {
      generated = await generate({
        prompt: built.prompt,
        outputSchema: createActivityTransactionTransportSchema(parsedInput.durationReferences.map(({ ref }) => ref)),
        ...(parsedInput.signal ? { signal: parsedInput.signal } : {}),
      });
    } catch (error) {
      const usage = providerFailureUsage(error);
      return {
        status: "failed",
        code: "provider_error",
        context: built.context,
        ...(usage ? { usage } : {}),
      };
    }

    const normalized = normalizeActivityTransactionTransport(
      generated.object,
      parsedInput.durationReferences.map(({ ref }) => ref),
    );
    const usage = generated.usage ? { usage: generated.usage } : {};
    const trace = generated.trace ? { trace: generated.trace } : {};
    return normalized.success && decisionFitsExtractorInput(parsedInput, normalized.decision)
      ? { status: "completed", decision: normalized.decision, context: built.context, ...usage, ...trace }
      : { status: "failed", code: "schema_error", context: built.context, ...usage, ...trace };
  };
}

export function normalizeActivityTransactionTransport(
  value: unknown,
  durationRefs: readonly string[],
): { success: true; decision: ActivityTransactionDecision } | { success: false } {
  const parsed = createActivityTransactionTransportSchema(durationRefs).safeParse(value);
  if (!parsed.success) return { success: false };
  const input = parsed.data;
  const emptyMutationFields = input.activities.length === 0
    && input.handle === null
    && input.expectedRevision === null
    && input.correctionMode === null
    && input.correction === null
    && input.replacementHandle === null
    && input.replacementExpectedRevision === null;

  let candidate: unknown;
  switch (input.kind) {
    case "none":
      if (!emptyMutationFields || input.reason !== "no_factual_activity") return { success: false };
      candidate = { kind: "none", reason: input.reason };
      break;
    case "needs_clarification":
      if (!emptyMutationFields || input.reason === null || input.reason === "no_factual_activity") return { success: false };
      candidate = { kind: "needs_clarification", reason: input.reason };
      break;
    case "collect":
      if (input.reason !== null || input.activities.length === 0
        || input.handle !== null || input.expectedRevision !== null || input.correctionMode !== null
        || input.correction !== null || input.replacementHandle !== null || input.replacementExpectedRevision !== null) return { success: false };
      candidate = { kind: "collect", activities: input.activities.map(withoutNullFacets) };
      break;
    case "correct":
      if (input.reason !== null || input.activities.length !== 0 || input.handle === null
        || input.expectedRevision === null || input.correctionMode === null || input.correction === null
        || input.replacementHandle !== null || input.replacementExpectedRevision !== null) return { success: false };
      candidate = {
        kind: "correct",
        handle: input.handle,
        expectedRevision: input.expectedRevision,
        mode: input.correctionMode,
        correction: withoutNullCorrectionFacets(input.correction),
      };
      break;
    case "supersede":
      if (input.reason !== null || input.activities.length !== 0 || input.handle === null
        || input.expectedRevision === null || input.correctionMode !== null || input.correction !== null
        || input.replacementHandle === null || input.replacementExpectedRevision === null) return { success: false };
      candidate = {
        kind: "supersede",
        handle: input.handle,
        expectedRevision: input.expectedRevision,
        replacementHandle: input.replacementHandle,
        replacementExpectedRevision: input.replacementExpectedRevision,
      };
      break;
  }
  const decision = activityTransactionDecisionSchema.safeParse(candidate);
  return decision.success ? { success: true, decision: decision.data } : { success: false };
}

function decisionFitsExtractorInput(
  input: ActivityTransactionExtractorInput,
  decision: ActivityTransactionDecision,
): boolean {
  if (input.mode === "record") {
    return decision.kind === "none"
      || decision.kind === "collect"
      || (decision.kind === "needs_clarification" && decision.reason === "activity_status_ambiguous");
  }
  if (decision.kind === "collect") return false;
  if (decision.kind === "needs_clarification" && decision.reason === "activity_status_ambiguous") return false;
  if (decision.kind === "correct") {
    return input.recentCandidates.some((candidate) =>
      candidate.handle === decision.handle && candidate.revision === decision.expectedRevision);
  }
  if (decision.kind === "supersede") {
    const selected = input.recentCandidates.some((candidate) =>
      candidate.handle === decision.handle && candidate.revision === decision.expectedRevision);
    const replacement = input.recentCandidates.some((candidate) =>
      candidate.handle === decision.replacementHandle && candidate.revision === decision.replacementExpectedRevision);
    return selected && replacement;
  }
  return true;
}

function providerFailureUsage(error: unknown): ModelTokenUsage | undefined {
  const usage = (error as { usage?: unknown } | undefined)?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const candidate = usage as Partial<ModelTokenUsage>;
  if (!Number.isSafeInteger(candidate.inputTokens) || candidate.inputTokens! < 0
    || !Number.isSafeInteger(candidate.outputTokens) || candidate.outputTokens! < 0
    || !Number.isSafeInteger(candidate.totalTokens) || candidate.totalTokens! < 0) return undefined;
  if (candidate.cachedInputTokens !== undefined
    && (!Number.isSafeInteger(candidate.cachedInputTokens) || candidate.cachedInputTokens < 0 || candidate.cachedInputTokens > candidate.inputTokens!)) return undefined;
  if (candidate.llmSteps !== undefined && (!Number.isSafeInteger(candidate.llmSteps) || candidate.llmSteps <= 0)) return undefined;
  return {
    inputTokens: candidate.inputTokens!,
    outputTokens: candidate.outputTokens!,
    totalTokens: candidate.totalTokens!,
    ...(candidate.llmSteps === undefined ? {} : { llmSteps: candidate.llmSteps }),
    ...(candidate.cachedInputTokens === undefined ? {} : { cachedInputTokens: candidate.cachedInputTokens }),
  };
}

function withoutNullFacets(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

function withoutNullCorrectionFacets(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== null
    || key === "routineId" || key === "routineLabel" || key === "recurrence"));
}
