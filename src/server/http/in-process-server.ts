import type {
  AcceptConsentInput,
  AgentRunner,
  ChatInput,
  CompleteOnboardingInput,
  IssueInviteInput,
  ListInsightsInput,
  MinutkaService,
  OpenInviteInput,
  RecordPrivacyExplanationShownInput,
  RedeemTelegramInviteInput,
  SubmitFeedbackInput,
} from "../../application/minutka-service.js";
import type { InMemoryWorld } from "../../application/in-memory-world.js";
import { createInMemoryRuntime } from "../../runtime/create-in-memory-runtime.js";

/** Spec-only in-process transport. It is not an HTTP listener. */
export type MinutkaApi = {
  chat(input: ChatInput): ReturnType<MinutkaService["chat"]>;
  issueInvite(input: IssueInviteInput): ReturnType<MinutkaService["issueInvite"]>;
  openInvite(input: OpenInviteInput): ReturnType<MinutkaService["openInvite"]>;
  redeemTelegramInvite(input: RedeemTelegramInviteInput): ReturnType<MinutkaService["redeemTelegramInvite"]>;
  recordPrivacyExplanationShown(input: RecordPrivacyExplanationShownInput): ReturnType<MinutkaService["recordPrivacyExplanationShown"]>;
  acceptConsent(input: AcceptConsentInput): ReturnType<MinutkaService["acceptConsent"]>;
  completeOnboarding(input: CompleteOnboardingInput): ReturnType<MinutkaService["completeOnboarding"]>;
  getProfile(input: { employeeId: string }): ReturnType<MinutkaService["getProfile"]>;
  listInsights(input: ListInsightsInput): ReturnType<MinutkaService["listInsights"]>;
  submitFeedback(input: SubmitFeedbackInput): ReturnType<MinutkaService["submitFeedback"]>;
};

export function createInProcessServer(service: MinutkaService): MinutkaApi {
  return {
    chat: (input) => service.chat(input), issueInvite: (input) => service.issueInvite(input),
    openInvite: (input) => service.openInvite(input),
    redeemTelegramInvite: (input) => service.redeemTelegramInvite(input),
    recordPrivacyExplanationShown: (input) => service.recordPrivacyExplanationShown(input),
    acceptConsent: (input) => service.acceptConsent(input),
    completeOnboarding: (input) => service.completeOnboarding(input), getProfile: (input) => service.getProfile(input),
    listInsights: (input) => service.listInsights(input), submitFeedback: (input) => service.submitFeedback(input),
  };
}

/** @deprecated Compatibility composition for executable specs only. */
export function createInProcessSpecServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
  deps: Parameters<typeof createInMemoryRuntime>[0]["deps"] = {},
): MinutkaApi {
  return createInProcessServer(createInMemoryRuntime({ world, agentRunner, deps }).service);
}
