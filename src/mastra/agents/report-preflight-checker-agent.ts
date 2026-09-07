import { Agent } from "@mastra/core/agent";
import { llmAgentConfig } from "../../config/llm.js";

/** Tool-free subordinate semantic checker for company-report routine names. */
export const reportPreflightCheckerAgent = new Agent({
  id: "minutka-report-preflight-checker",
  name: "Minutka Report Preflight Checker",
  instructions: [
    "Check routine names for identifying details that deterministic lint may miss.",
    "Return strict structured output only. Do not call tools, read memory, edit files, or infer identity beyond the supplied names.",
  ].join(" "),
  tools: {},
  editor: false,
  ...llmAgentConfig,
});
