import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const updateProfileTool = createTool({
  id: "update-profile-tool",
  description:
    "Report requested Minutka profile changes. Persistent profile updates are handled by the application onboarding flow, not by this runtime tool.",
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
  execute: async () => ({
    updated: false,
    changedFields: [],
  }),
});
