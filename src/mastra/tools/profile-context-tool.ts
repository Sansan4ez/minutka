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
  /** Only an explicit employee request or confirmation may update this list; explicit correction replaces it. */
  typicalTasksMode: z.enum(["append", "replace"]).optional(),
  aiLevel: aiLevelSchema.optional(),
  programGoal: z.string().trim().min(1).max(500).optional(),
});

/** Saves only employee-stated bounded profile context for the authenticated owner. */
export function createUpdatePersonalContextTool(
  update: (patch: PersonalContextPatch, options: { replaceTypicalTasks: boolean }) => Promise<{ changedFields: string[] }>,
) {
  return createTool({
    id: updatePersonalContextToolName,
    description: "Save the authenticated employee's bounded profile context only after an explicit request or confirmation. A factual activity report is not profile confirmation; a turn recorded through processCurrentActivityTurn must not also call this tool. Accepted fields: preferred name, communication style, answer length, IANA timezone, role self-description, recurring tasks, AI experience level, and program goal. Recurring tasks append by default. For an explicit drop, rename, or rewrite, or when the seven-task list is full, send the complete wanted list with typicalTasksMode \"replace\". Never target another employee, ask a questionnaire, infer values, or save unverified observations. Send only confirmed or explicitly corrected fields.",
    strict: true,
    inputSchema: personalProfileContextPatchSchema,
    outputSchema: z.strictObject({ recorded: z.literal(true), changedFields: z.array(z.enum(["preferredName", "persona", "responseLength", "timezone", "role", "typicalTasks", "aiLevel", "programGoal"])) }),
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async ({ typicalTasksMode, ...patch }) => {
      const result = await update(patch, { replaceTypicalTasks: typicalTasksMode === "replace" });
      return { recorded: true as const, changedFields: result.changedFields as Array<"preferredName" | "persona" | "responseLength" | "timezone" | "role" | "typicalTasks" | "aiLevel" | "programGoal"> };
    },
  });
}
