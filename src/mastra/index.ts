import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { minutkaAgent } from "./agents/minutka-agent.js";
import { agentManualRouterAgent } from "./agents/agent-manual-router-agent.js";
import { conversationDecisionAgent } from "./agents/conversation-decision-agent.js";
import { insightExtractorAgent } from "./agents/insight-extractor-agent.js";

/**
 * Agent registry for development tooling. Conversation history is owned by
 * the application ConversationStore and rendered into runtime context.
 */
export const mastra = new Mastra({
  // This serves Studio/import smoke only. Application conversation history is
  // deliberately not connected to Mastra storage in Phase 4.1.
  storage: new InMemoryStore(),
  agents: {
    minutkaAgent,
    agentManualRouterAgent,
    conversationDecisionAgent,
    insightExtractorAgent,
  },
});
