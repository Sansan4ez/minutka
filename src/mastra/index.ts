import { Mastra } from "@mastra/core";
import { minutkaAgent } from "./agents/minutka-agent.js";

export const mastra = new Mastra({
  agents: { minutkaAgent },
});
