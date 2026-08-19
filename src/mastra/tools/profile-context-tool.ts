import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { aiLevelSchema } from "../../contracts/minutka-api.js";
import type { PersonalProfileContextPatch } from "../../application/personal-profile-context.js";

export const updatePersonalContextToolName = "updatePersonalContext" as const;

export const personalProfileContextPatchSchema = z.strictObject({
  typicalTasks: z.array(z.string().trim().min(1).max(160)).min(1).max(7).optional(),
  aiLevel: aiLevelSchema.optional(),
  programGoal: z.string().trim().min(1).max(500).optional(),
});

/** Saves only employee-stated bounded profile context for the authenticated owner. */
export function createUpdatePersonalContextTool(
  update: (patch: PersonalProfileContextPatch) => Promise<{ changedFields: string[] }>,
) {
  return createTool({
    id: updatePersonalContextToolName,
    description: "Save employee-only working context that the employee stated in ordinary conversation: recurring task summaries, closed AI experience level, or their goal for the program. Do not ask a questionnaire, do not infer missing values, and do not copy long verbatim text. Omit fields the employee did not state.",
    strict: true,
    inputSchema: personalProfileContextPatchSchema,
    outputSchema: z.strictObject({ recorded: z.literal(true), changedFields: z.array(z.enum(["typicalTasks", "aiLevel", "programGoal"])) }),
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async (patch) => {
      const result = await update(patch);
      return { recorded: true as const, changedFields: result.changedFields as Array<"typicalTasks" | "aiLevel" | "programGoal"> };
    },
  });
}
