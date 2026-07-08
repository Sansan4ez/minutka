import type { InMemoryWorld } from "../../application/in-memory-world.js";
import {
  MinutkaService,
  type AgentRunner,
  type ChatInput,
} from "../../application/minutka-service.js";

export type MinutkaApi = ReturnType<typeof createInProcessServer>;

export function createInProcessServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
) {
  const service = new MinutkaService(world, agentRunner);

  return {
    chat(input: ChatInput) {
      return service.chat(input);
    },
  };
}
