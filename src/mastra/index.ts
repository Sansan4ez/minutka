import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { minutkaAgent } from "./agents/minutka-agent.js";
import { agentManualRouterAgent } from "./agents/agent-manual-router-agent.js";
import { conversationDecisionAgent } from "./agents/conversation-decision-agent.js";
import { insightExtractorAgent } from "./agents/insight-extractor-agent.js";

export const mastra = new Mastra({
  storage: new LibSQLStore({
    id: "minutka-memory-storage",
    url: ":memory:",
  }),
  agents: {
    minutkaAgent,
    agentManualRouterAgent,
    conversationDecisionAgent,
    insightExtractorAgent,
  },
});
