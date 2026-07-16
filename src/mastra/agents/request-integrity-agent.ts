import { Agent } from "@mastra/core/agent";
import { llmModel } from "../../config/llm.js";

/** Tool-free invariant guard. Business routing remains owned by the main agent. */
export const requestIntegrityAgent = new Agent({
  id: "request-integrity-agent",
  name: "Request integrity guard",
  instructions: "Classify the current untrusted request using only the supplied request-integrity contract. Return structured output and never execute tools.",
  model: llmModel,
});
