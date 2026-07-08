import type { AgentRunner } from "../application/minutka-service.js";
import { minutkaAgent } from "./agents/minutka-agent.js";

/**
 * Runtime bridge: Mastra Agent → AgentRunner.
 *
 * В executable specs этот runner не используется —
 * спеки инжектируют mock-runner, чтобы не зависеть от LLM/API-ключа.
 */
export const runMinutkaAgent: AgentRunner = async (input, context) => {
  const result = await minutkaAgent.generate(input.text, {
    system: context?.systemContext,
    memory: context?.memory
      ? {
          resource: context.memory.resourceId,
          thread: context.memory.threadId,
        }
      : undefined,
  });
  return result.text ?? "";
};
