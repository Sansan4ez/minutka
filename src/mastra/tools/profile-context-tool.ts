import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { aiLevelSchema } from "../../contracts/minutka-api.js";
import type { PersonalContextPatch } from "../../application/personal-context-review.js";

export const updatePersonalContextToolName = "updatePersonalContext" as const;

export const personalProfileContextPatchSchema = z.strictObject({
  preferredName: z.string().trim().min(1).max(128).optional(),
  persona: z.enum(["support", "efficiency"]).optional(),
  responseLength: z.enum(["short", "balanced", "detailed"]).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  role: z.string().trim().min(1).max(2_000).optional(),
  typicalTasks: z.array(z.string().trim().min(1).max(160)).min(1).max(7).optional(),
  aiLevel: aiLevelSchema.optional(),
  programGoal: z.string().trim().min(1).max(500).optional(),
});

/** Saves only employee-stated bounded profile context for the authenticated owner. */
export function createUpdatePersonalContextTool(
  update: (patch: PersonalContextPatch) => Promise<{ changedFields: string[] }>,
) {
  return createTool({
    id: updatePersonalContextToolName,
    description: "Correct the authenticated employee's own confirmed profile after an explicit request: preferred name, communication style, answer length, IANA timezone, role self-description, recurring tasks, closed AI experience level, or program goal. Never target another employee, infer a value, or save an unverified observation as fact. Omit fields the employee did not explicitly ask to change.",
    strict: true,
    inputSchema: personalProfileContextPatchSchema,
    outputSchema: z.strictObject({ recorded: z.literal(true), changedFields: z.array(z.enum(["preferredName", "persona", "responseLength", "timezone", "role", "typicalTasks", "aiLevel", "programGoal"])) }),
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async (patch) => {
      const result = await update(patch);
      return { recorded: true as const, changedFields: result.changedFields as Array<"preferredName" | "persona" | "responseLength" | "timezone" | "role" | "typicalTasks" | "aiLevel" | "programGoal"> };
    },
  });
}
