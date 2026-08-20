import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  collectActivitiesInputSchema,
  collectActivitiesMaximumItems,
  type CollectActivitiesInput,
} from "../../contracts/minutka-activity.js";
import type { CollectActivitiesResult } from "../../application/activity-collection.js";

export const collectActivitiesToolName = "collectActivities" as const;

/** Records a batch of separate structured activities for the authenticated employee. */
export function createCollectActivitiesTool(
  collectActivities: (input: CollectActivitiesInput) => Promise<CollectActivitiesResult>,
) {
  return createTool({
    id: collectActivitiesToolName,
    description: `Record all employee activities named in the current message through authenticated tenant-bound typed calls. Put each activity in its own array item. Each call accepts at most ${collectActivitiesMaximumItems} items; if the message contains more, preserve input order and continue with the remaining items in the next call. Omit unknown fields and never send free text. For each item send at most one obstacle field — routinePattern, automationCandidate, or energyStressMarker — and omit the other two; if more than one arrives, only the first of that order is recorded. If the result status is failed or partial, tell the employee the savedCount, plainly say the remaining activities were not recorded, do not claim a complete write, and do not retry automatically.`,
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
