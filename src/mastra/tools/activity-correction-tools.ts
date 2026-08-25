import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  activityCorrectionModes,
  type ActivityMutationResult,
  type CorrectRecentActivityInput,
  type SupersedeRecentActivityInput,
} from "../../application/activity-correction.js";
import {
  createProviderActivitySchemas,
  DurationEvidenceValidationError,
  type ProviderCorrectRecentActivityInput,
  type RequestDurationEvidence,
} from "../../application/activity-duration-evidence.js";

export const correctRecentActivityToolName = "correctRecentActivity" as const;
export const supersedeRecentActivityToolName = "supersedeRecentActivity" as const;

const mutationResultSchema = z.strictObject({
  status: z.literal("completed"),
  handle: z.string().min(1),
  revision: z.number().int().min(1),
});

const correctionToolResultSchema = z.union([
  mutationResultSchema,
  z.strictObject({
    status: z.literal("failed"),
    validation: z.strictObject({ code: z.enum(["unknown_duration_ref", "duration_ref_already_used"]) }),
  }),
]);

export function createCorrectRecentActivityTool(
  correctRecentActivity: (input: CorrectRecentActivityInput) => Promise<ActivityMutationResult>,
  durationEvidence: RequestDurationEvidence,
) {
  return createTool({
    id: correctRecentActivityToolName,
    description: "Correct exactly one recent activity selected from readRecentOwnActivities. Use only after the employee explicitly corrects or clarifies that episode and one candidate is unambiguous. Pass its opaque handle and revision. mode patch changes only supplied closed facets; mode replace clears omitted facets and replaces the closed facet set. To set duration, use only an available request-local durationRef from the current correction message and associate it with this selected episode; omit it when uncertain. Never emit durationBucket directly. Never create a new activity for the correction, never pass identity fields or free text, and never retry a conflict with a guessed revision.",
    strict: true,
    inputSchema: z.strictObject({
      handle: z.string().trim().min(1),
      expectedRevision: z.number().int().min(1),
      mode: z.enum(activityCorrectionModes),
      correction: createProviderActivitySchemas(durationEvidence.candidates).correctionPatch,
    }),
    outputSchema: correctionToolResultSchema,
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async (input: ProviderCorrectRecentActivityInput) => {
      try {
        const prepared = durationEvidence.prepareCorrection(input);
        const result = await correctRecentActivity(prepared.input);
        durationEvidence.consumeCorrection(prepared.durationRef);
        return result;
      } catch (error) {
        if (error instanceof DurationEvidenceValidationError) return { status: "failed" as const, validation: error.detail };
        throw error;
      }
    },
  });
}

export function createSupersedeRecentActivityTool(
  supersedeRecentActivity: (input: SupersedeRecentActivityInput) => Promise<ActivityMutationResult>,
) {
  return createTool({
    id: supersedeRecentActivityToolName,
    description: "Mark one recent activity as a confirmed duplicate or replaced row while keeping it in research provenance. Use only after explicit employee confirmation and an unambiguous pair returned by readRecentOwnActivities. handle is the duplicate to exclude from current summaries/report; replacementHandle is the active row to keep. Pass both current revisions. Never infer duplicates, automatically merge, or retry a conflict with guessed revisions.",
    strict: true,
    inputSchema: z.strictObject({
      handle: z.string().trim().min(1),
      expectedRevision: z.number().int().min(1),
      replacementHandle: z.string().trim().min(1),
      replacementExpectedRevision: z.number().int().min(1),
    }),
    outputSchema: mutationResultSchema,
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: supersedeRecentActivity,
  });
}
