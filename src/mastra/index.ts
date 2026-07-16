import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { personalAssistantAgent } from "./agents/personal-assistant-agent.js";
import { onboardingProfileExtractorAgent } from "./agents/onboarding-profile-extractor-agent.js";

/**
 * Agent registry for development tooling. Conversation history is owned by
 * the application ConversationStore and rendered into runtime context.
 */
export const mastra = new Mastra({
  // This serves Studio/import smoke only. Application conversation history is
  // deliberately not connected to Mastra storage in Phase 4.1.
  storage: new InMemoryStore(),
  agents: {
    personalAssistantAgent,
    onboardingProfileExtractorAgent,
  },
});
