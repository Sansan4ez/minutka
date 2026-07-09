import type { InMemoryWorld } from "../../application/in-memory-world.js";
import { createInMemoryProfileStore } from "../../application/in-memory-profile-store.js";
import { createMastraMinutkaServiceDeps } from "../../mastra/runtime-deps.js";
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
  depsOrProfileStore?: MinutkaServiceDeps | ProfileStore,
) {
  const defaultDeps = createMastraMinutkaServiceDeps({
    profileStore: createInMemoryProfileStore(world),
  });
  const deps = depsOrProfileStore
    ? isProfileStore(depsOrProfileStore)
      ? { ...defaultDeps, profileStore: depsOrProfileStore }
      : { ...defaultDeps, ...depsOrProfileStore }
    : defaultDeps;
  const service = new MinutkaService(world, agentRunner, deps);

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

function isProfileStore(value: MinutkaServiceDeps | ProfileStore): value is ProfileStore {
  return (
    typeof (value as ProfileStore).getProfile === "function" &&
    typeof (value as ProfileStore).saveProfile === "function"
  );
}
