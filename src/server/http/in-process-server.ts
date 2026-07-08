import type { InMemoryWorld } from "../../application/in-memory-world.js";
import { createInMemoryProfileStore } from "../../application/in-memory-profile-store.js";
import {
  MinutkaService,
  type AcceptConsentInput,
  type AgentRunner,
  type ChatInput,
  type CompleteOnboardingInput,
  type OpenInviteInput,
} from "../../application/minutka-service.js";
import type { ProfileStore } from "../../application/profile-store.js";

export type MinutkaApi = ReturnType<typeof createInProcessServer>;

export function createInProcessServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
  profileStore: ProfileStore = createInMemoryProfileStore(world),
) {
  const service = new MinutkaService(world, agentRunner, profileStore);

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
  };
}
