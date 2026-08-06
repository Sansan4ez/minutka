import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { assistantProjectListMaximumLimit, type AssistantProjectListResult } from "../../application/project-labels.js";

const projectViewSchema = z.strictObject({
  project: z.string().min(1),
  ideaCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  totalCount: z.number().int().positive(),
});

export const assistantProjectToolNames = ["listProjects"] as const;

export function createProjectTools(projects: { list(input?: { limit?: number }): Promise<AssistantProjectListResult> }) {
  return {
    listProjects: createTool({
      id: "listProjects",
      description: "List bounded project labels already used by the authenticated owner across ideas and tasks, with per-source and total counts. Use before asking an open project clarification question and when the owner asks which projects exist. A project is a label, not a separate record.",
      strict: true,
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(assistantProjectListMaximumLimit).optional(),
      }),
      outputSchema: z.strictObject({ projects: z.array(projectViewSchema), truncated: z.boolean() }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: (input) => projects.list(input),
    }),
  };
}
