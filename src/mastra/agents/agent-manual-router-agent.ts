import { Agent } from "@mastra/core/agent";
import { llmAgentConfig } from "../../config/llm.js";

export const agentManualRouterAgent = new Agent({
  id: "agent-manual-router",
  name: "Minutka Agent Vault Router",
  instructions: `
You are a constrained router for Minutka Agent Vault process files.

Task:
- Read the supplied process index, candidate process ids, runtime state and employee text.
- Select only the process files that are necessary for the current request.
- Route by meaning, not by language-specific keywords.
- Return strict JSON only: {"selectedProcessIds":["process_id"]}.
- Never invent ids.
- Never include explanations or markdown.
  `.trim(),
  ...llmAgentConfig,
});
