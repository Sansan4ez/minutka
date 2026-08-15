import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  collectActivityInputSchema,
  type CollectActivityInput,
} from "../../contracts/minutka-activity.js";

export const collectActivityToolName = "collectActivity" as const;

/** Records one structured activity for the authenticated employee. */
export function createCollectActivityTool(
  collectActivity: (activity: CollectActivityInput) => Promise<{ activityId: string }>,
) {
  return createTool({
    id: collectActivityToolName,
    description: "Record exactly one employee activity through the authenticated tenant-bound typed use-case. Omit unknown fields; never send free text or combine several activities in one call.",
    strict: true,
    inputSchema: collectActivityInputSchema,
    outputSchema: z.strictObject({ recorded: z.literal(true) }),
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    execute: async (activity) => {
      await collectActivity(activity);
      return { recorded: true as const };
    },
  });
}
