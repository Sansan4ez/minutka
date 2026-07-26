import { readFileSync } from "node:fs";
import { Agent } from "@mastra/core/agent";
import { llmAgentConfig } from "../../config/llm.js";
import { findRepoRoot } from "../../application/agent-manual-loader.js";

export const threadSummarizerAgent = new Agent({
  id: "personal-assistant-thread-summarizer",
  name: "Personal Assistant Thread Summarizer",
  instructions: readFileSync(
    `${findRepoRoot(process.cwd())}/vault/assistant/thread-summary-prompt.md`,
    "utf8",
  ).trim(),
  ...llmAgentConfig,
});
