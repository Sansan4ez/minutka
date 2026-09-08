import {
  reportPreflightLlmResponseSchema,
  type ReportPreflightLlmGenerator,
  type ReportPreflightLlmRoutine,
} from "../application/report-preflight-llm.js";
import { reportPreflightCheckerAgent } from "./agents/report-preflight-checker-agent.js";

export const reportPreflightLlmPromptVersion = "minutka-report-preflight/v1" as const;

export function buildReportPreflightLlmPrompt(input: { routines: ReportPreflightLlmRoutine[] }): string {
  return [
    "# Report preflight",
    "Inspect each canonical routine name for identifying details that a deterministic text lint may miss.",
    "Return exactly one result for every routine key. Use verdict ok when the name is safe for a company-facing report; use verdict flag only when the name identifies a person, organization, location, unique role, or similarly identifying combination. A flag must include a concise reason; ok must use an empty reason string.",
    "Do not rewrite names. Variants are context only and must not be returned as excerpts.",
    `# Prompt version\n${reportPreflightLlmPromptVersion}`,
    "# Routines",
    JSON.stringify(input.routines),
  ].join("\n");
}

export const checkReportPreflightWithAgent: ReportPreflightLlmGenerator = async (input) => {
  const result = await reportPreflightCheckerAgent.generate(buildReportPreflightLlmPrompt(input), {
    structuredOutput: { schema: reportPreflightLlmResponseSchema, errorStrategy: "strict" },
    toolChoice: "none",
    maxSteps: 1,
  });
  return { object: result.object };
};
