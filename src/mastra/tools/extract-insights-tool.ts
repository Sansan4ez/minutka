import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const insightSummary = z.object({
  kind: z.enum([
    "task_category",
    "routine_pattern",
    "energy_stress_marker",
    "automation_candidate",
  ]),
  label: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const extractInsightsTool = createTool({
  id: "extract-insights-tool",
  description:
    "Deprecated runtime primitive placeholder. Structured insight extraction is handled by the constrained insightExtractorAgent service boundary.",
  inputSchema: z.object({
    employeeId: z.string().min(1),
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string().min(1),
  }),
  outputSchema: z.object({
    insights: z.array(insightSummary),
  }),
  execute: async () => ({
    insights: [],
  }),
});
