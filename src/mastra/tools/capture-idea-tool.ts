import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { recordTypeSchema } from "../../contracts/minutka-api.js";
import type { CaptureIdeaResult } from "../../application/ingestion-service.js";

const captureIdeaInputSchema = z.strictObject({
  project: z.string(),
  type: recordTypeSchema,
  summary: z.string().min(1),
  suggestedNextStep: z.string().min(1),
  needsProjectClarification: z.boolean(),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
    z.strictObject({ kind: z.literal("blob"), blobKey: z.string().min(1) }),
  ]).optional(),
});

const captureIdeaOutputSchema = z.strictObject({
  ideaId: z.string().min(1),
  project: z.string().min(1),
  response: z.string().min(1),
  needsProjectClarification: z.boolean(),
});

/**
 * Creates the sole agent-facing writer for a classified inbox item. The closure
 * is bound to the trusted request owner by AssistantService, never by model input.
 */
export function createCaptureIdeaTool(captureIdea: (input: z.infer<typeof captureIdeaInputSchema>) => Promise<CaptureIdeaResult>) {
  return createTool({
    id: "captureIdea",
    description: "Save a classified owner idea. Use for every inbound idea before replying.",
    inputSchema: captureIdeaInputSchema,
    outputSchema: captureIdeaOutputSchema,
    execute: async (input) => {
      const result = await captureIdea(input);
      return {
        ideaId: result.idea.id,
        project: result.idea.project,
        response: result.response,
        needsProjectClarification: result.needsProjectClarification,
      };
    },
  });
}
