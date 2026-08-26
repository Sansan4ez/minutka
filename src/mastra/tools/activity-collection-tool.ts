import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { collectActivitiesMaximumItems, type CollectActivitiesInput } from "../../contracts/minutka-activity.js";
import {
  createProviderActivitySchemas,
  DurationEvidenceValidationError,
  type ProviderCollectActivitiesInput,
  type RequestDurationEvidence,
} from "../../application/activity-duration-evidence.js";
import type { CollectActivitiesResult } from "../../application/activity-collection.js";
import { activitySystemModelMappingGuide } from "./activity-system-mapping.js";

export const collectActivitiesToolName = "collectActivities" as const;

export const collectActivitiesToolDescription =
  `Record every completed or in-progress activity explicitly reported in the current employee message through authenticated tenant-bound typed calls. Put one factual activity in each array item. Each call accepts at most ${collectActivitiesMaximumItems} items; above that, preserve input order across calls. The current employee message is the evidence boundary for every optional facet: emit a field only when that message explicitly supports the field for that activity; absence is represented by omitting the key, never by a plausible default. Duration is available only through an optional request-local durationRef listed in the provider schema; associate a ref with the correct factual activity, use each ref at most once, and omit durationRef when no explicit measurement belongs to that activity. Never emit a duration bucket directly. Do not infer a system, routinePattern, automationCandidate, or energyStressMarker from the activity category, role, company context, or what usually happens in such work. system: a meeting or call with no system or named channel omits this field; also omit when the generic type is ambiguous. Use other only when an explicit known system type is outside the taxonomy. ${activitySystemModelMappingGuide} routinePattern: omit ordinary meetings, calls, coordination, reporting, focused work, and template preparation unless the employee explicitly describes matching friction; use other only for explicit routine friction outside the taxonomy. automationCandidate: omit unless the employee explicitly states evidence for an automation opportunity; use other only for an explicit opportunity outside the taxonomy. energyStressMarker: omit unless the employee explicitly states a covered work-related energy/stress signal; neutral is never a default and this facet has no other. routinePattern, automationCandidate, and energyStressMarker are independent: when explicit evidence supports all of them for one activity, include all three in that same item. Omit unknown fields and all free text; never infer emotion. If input validation rejects a call, use the bounded validation detail returned by the tool to retry within this same agent turn with only closed values, available duration refs, or omitted unsupported keys, so the factual activity is not lost. Do not retry persistence failed or partial statuses automatically; report savedCount and that the remainder was not recorded.`;

/** Records a batch of separate structured activities for the authenticated employee. */
export function createCollectActivitiesTool(
  collectActivities: (input: CollectActivitiesInput) => Promise<CollectActivitiesResult>,
  durationEvidence: RequestDurationEvidence,
) {
  const providerInputSchema = z.strictObject({
    activities: z.array(createProviderActivitySchemas(durationEvidence.candidates).collectionItem)
      .min(1)
      .max(collectActivitiesMaximumItems),
  });
  return createTool({
    id: collectActivitiesToolName,
    description: collectActivitiesToolDescription,
    strict: true,
    inputSchema: providerInputSchema,
    outputSchema: z.strictObject({
      status: z.enum(["completed", "failed", "partial"]),
      savedCount: z.number().int().nonnegative(),
      validation: z.strictObject({ code: z.enum(["unknown_duration_ref", "duration_ref_already_used"]) }).optional(),
    }),
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    execute: async (input) => {
      try {
        const prepared = durationEvidence.prepareCollection(input as ProviderCollectActivitiesInput);
        const result = await collectActivities(prepared.input);
        durationEvidence.consumeCollection(prepared.refsByActivity, result.savedCount);
        return { status: result.status, savedCount: result.savedCount };
      } catch (error) {
        if (error instanceof DurationEvidenceValidationError) {
          return { status: "failed" as const, savedCount: 0, validation: error.detail };
        }
        throw error;
      }
    },
  });
}
