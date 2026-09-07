import { Agent } from "@mastra/core/agent";
import { llmAgentConfig } from "../../config/llm.js";

/** Tool-free subordinate semantic center for operator review suggestions. */
export const routineDirectorySuggestAgent = new Agent({
  id: "minutka-routine-directory-suggester",
  name: "Minutka Routine Directory Suggester",
  instructions: [
    "Suggest routine-directory proposals from bounded role reference data and untrusted employee evidence.",
    "Return strict structured output only. Do not call tools, read memory, edit files, or infer identity.",
  ].join(" "),
  tools: {},
  editor: false,
  ...llmAgentConfig,
});
