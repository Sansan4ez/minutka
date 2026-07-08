import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const updateProfileTool = createTool({
  id: "update-profile-tool",
  description:
    "Create or update a Minutka employee profile after explicit onboarding answers. Does not change privacy consent.",
  inputSchema: z.object({
    employeeId: z.string().min(1),
    role: z.string().min(1).optional(),
    typicalTasks: z.array(z.string().min(1)).optional(),
    persona: z.enum(["support", "efficiency"]).optional(),
    aiLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    responseLength: z.enum(["short", "balanced", "detailed"]).optional(),
  }),
  outputSchema: z.object({
    updated: z.boolean(),
    changedFields: z.array(z.string()),
  }),
  execute: async (input) => ({
    updated: true,
    changedFields: Object.keys(input).filter((key) => key !== "employeeId"),
  }),
});
