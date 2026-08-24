import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  collectActivitiesInputSchema,
  collectActivitiesMaximumItems,
  type CollectActivitiesInput,
} from "../../contracts/minutka-activity.js";
import type { CollectActivitiesResult } from "../../application/activity-collection.js";
import { activitySystemModelMappingGuide } from "./activity-system-mapping.js";

export const collectActivitiesToolName = "collectActivities" as const;

export const collectActivitiesToolDescription =
  `Record all employee activities named in the current message through authenticated tenant-bound typed calls. Put each activity in its own array item. Each call accepts at most ${collectActivitiesMaximumItems} items; above that, preserve input order across calls. Omit unknown fields and free text. For system and every obstacle facet: unnamed/unknown means omit; unambiguously covered means a concrete enum; explicitly known but not covered means other where that enum has it. ${activitySystemModelMappingGuide} energyStressMarker has no other and requires an explicit covered work-related signal. A meeting or call without a named channel has no system. Ordinary meetings, calls, work, and template preparation without named friction have no routinePattern. routinePattern, automationCandidate, and energyStressMarker are independent optional facets: include every facet explicitly supported by the employee's account in the same activity item, and never infer emotion. On failed or partial status, report savedCount and that the remainder was not recorded; do not claim completion or retry automatically.`;

/** Records a batch of separate structured activities for the authenticated employee. */
export function createCollectActivitiesTool(
  collectActivities: (input: CollectActivitiesInput) => Promise<CollectActivitiesResult>,
) {
  return createTool({
    id: collectActivitiesToolName,
    description: collectActivitiesToolDescription,
    strict: true,
    inputSchema: collectActivitiesInputSchema,
    outputSchema: z.strictObject({
      status: z.enum(["completed", "failed", "partial"]),
      savedCount: z.number().int().nonnegative(),
    }),
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    execute: async (input) => {
      const result = await collectActivities(input);
      return { status: result.status, savedCount: result.savedCount };
    },
  });
}
