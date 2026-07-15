import type { AssistantAgentRunner } from "../application/assistant-service.js";
import type { AgentRunner } from "../application/minutka-service.js";
import { createCaptureIdeaTool } from "./tools/capture-idea-tool.js";
import { minutkaAgent } from "./agents/minutka-agent.js";

export type MinutkaAgentLike = {
  generate(
    text: string,
    options: { system?: string; toolChoice?: "auto" | "none"; maxSteps?: number; toolsets?: Record<string, Record<string, unknown>> },
  ): Promise<{ text?: string }>;
};

/**
 * Runtime bridge: Mastra Agent → AgentRunner.
 *
 * Conversation history is owned by the application ConversationStore and is
 * rendered into systemContext. Do not pass Mastra memory identifiers here:
 * Phase 4.1 deliberately disables duplicate Mastra message history.
 */
export function createMinutkaAgentRunner(agent: MinutkaAgentLike): AgentRunner {
  return async (input, context) => {
    const result = await agent.generate(input.text, {
      system: context?.systemContext,
      // Profile updates and insight persistence are application use cases.
      // Do not begin a Mastra tool loop: the configured OpenAI-compatible
      // gateway does not persist function-call items between loop steps.
      toolChoice: "none",
    });
    return result.text ?? "";
  };
}

/**
 * In executable specs this runner is not used — they inject mocks so checks
 * remain independent from the LLM provider.
 */
export const runMinutkaAgent = createMinutkaAgentRunner(minutkaAgent);

/** Runtime bridge for the personal assistant; only the reversible capture tool is enabled. */
export function createAssistantAgentRunner(agent: MinutkaAgentLike): AssistantAgentRunner {
  return async (input, context) => {
    const result = await agent.generate(input.text, {
      system: context.systemContext,
      toolChoice: "auto",
      toolsets: { inbox: { captureIdea: createCaptureIdeaTool(context.captureIdea) } },
      maxSteps: 2,
    });
    return result.text ?? "";
  };
}
