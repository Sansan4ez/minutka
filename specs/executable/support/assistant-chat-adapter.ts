import type { AssistantChatResult } from "../../../src/application/assistant-service.js";
import type { MinutkaService } from "../../../src/application/minutka-service.js";
import type { HttpApplicationService } from "../../../src/server/http/http-server.js";

/** Historical application-spec adapter. Production HTTP always receives AssistantService. */
export function createSpecAssistantChat(service: Pick<MinutkaService, "chat">) {
  return {
    async chat(input: { userId: string; threadId: string; text: string; inputModality?: "text" | "voice"; responseChannel?: "generic" | "telegram" }): Promise<AssistantChatResult> {
      const result = await service.chat({
        employeeId: input.userId,
        threadId: input.threadId,
        text: input.text,
        inputModality: input.inputModality,
        responseChannel: input.responseChannel,
      });
      return {
        ...result,
        selectedProcessIds: result.selectedProcessIds.includes("inbox_capture") ? ["core", "inbox_capture"] : ["core"],
        outcome: { status: "completed" },
      };
    },
  };
}

/** Spec-only compatibility facade; production constructs PersonalAssistantService. */
export function createSpecHttpApplication(
  service: MinutkaService,
  assistant: Pick<HttpApplicationService, "chat"> = createSpecAssistantChat(service),
): HttpApplicationService {
  return {
    issueInvite: (input) => service.issueInvite(input),
    openInvite: (input) => service.openInvite(input),
    getProfile: (input) => service.getProfile(input),
    acceptConsent: (input) => service.acceptConsent(input),
    completeOnboarding: (input) => service.completeOnboarding(input),
    listInsights: (input) => service.listInsights(input),
    submitFeedback: (input) => service.submitFeedback(input),
    redeemTelegramInvite: (input) => service.redeemTelegramInvite(input),
    recordPrivacyExplanationShown: (input) => service.recordPrivacyExplanationShown(input),
    submitOnboardingAnswer: (input) => service.submitOnboardingAnswer(input),
    confirmOnboarding: (input) => service.confirmOnboarding(input),
    resetOnboardingDraft: (input) => service.resetOnboardingDraft(input),
    chat: (input) => assistant.chat(input),
  };
}
