import type { MinutkaServiceDeps } from "../application/minutka-service.js";
import { routeAgentManualProcesses } from "./agent-manual-router.js";
import { routeConversationDecision } from "./conversation-decision-router.js";
import { extractInsightsWithAgent } from "./insight-extractor.js";

export function createMastraMinutkaServiceDeps(
  overrides: MinutkaServiceDeps = {},
): MinutkaServiceDeps {
  return {
    agentManualRouter: routeAgentManualProcesses,
    conversationDecisionRouter: routeConversationDecision,
    insightExtractor: extractInsightsWithAgent,
    ...overrides,
  };
}
