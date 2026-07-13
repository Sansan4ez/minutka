import type { MinutkaServiceDeps } from "../application/minutka-service.js";
import { routeConversationDecision } from "./conversation-decision-router.js";
import { extractInsightsWithAgent } from "./insight-extractor.js";
import { extractOnboardingProfileWithAgent } from "./onboarding-profile-extractor.js";

export function createMastraMinutkaServiceDeps(
  overrides: MinutkaServiceDeps = {},
): MinutkaServiceDeps {
  return {
    conversationDecisionRouter: routeConversationDecision,
    insightExtractor: extractInsightsWithAgent,
    onboardingProfileExtractor: extractOnboardingProfileWithAgent,
    ...overrides,
  };
}
