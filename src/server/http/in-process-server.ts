import type { InMemoryWorld } from "../../application/in-memory-world.js";
import { createInMemoryProfileStore } from "../../application/in-memory-profile-store.js";
import {
  MinutkaService,
  type AcceptConsentInput,
  type AgentRunner,
  type ChatInput,
  type CompleteOnboardingInput,
  type ListInsightsInput,
  type MinutkaServiceDeps,
  type OpenInviteInput,
  type SubmitFeedbackInput,
} from "../../application/minutka-service.js";
import type { ProfileStore } from "../../application/profile-store.js";

export type MinutkaApi = ReturnType<typeof createInProcessServer>;

export function createInProcessServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
  depsOrProfileStore: MinutkaServiceDeps | ProfileStore = createInMemoryProfileStore(world),
) {
  const service = new MinutkaService(world, agentRunner, depsOrProfileStore);

  return {
    chat(input: ChatInput) {
      return service.chat(input);
    },
    openInvite(input: OpenInviteInput) {
      return service.openInvite(input);
    },
    acceptConsent(input: AcceptConsentInput) {
      return service.acceptConsent(input);
    },
    completeOnboarding(input: CompleteOnboardingInput) {
      return service.completeOnboarding(input);
    },
    getProfile(input: { employeeId: string }) {
      return service.getProfile(input);
    },
    listInsights(input: ListInsightsInput) {
      return service.listInsights(input);
    },
    submitFeedback(input: SubmitFeedbackInput) {
      return service.submitFeedback(input);
    },
  };
}
