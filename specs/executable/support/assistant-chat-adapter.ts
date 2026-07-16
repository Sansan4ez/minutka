import type { AssistantChatResult } from "../../../src/application/assistant-service.js";
import type { MinutkaService } from "../../../src/application/minutka-service.js";

/** Historical application-spec adapter. Production HTTP always receives AssistantService. */
export function createSpecAssistantChat(service: Pick<MinutkaService, "chat">) {
  return {
    async chat(input: { userId: string; threadId: string; text: string; inputModality?: "text" | "voice" }): Promise<AssistantChatResult> {
      const result = await service.chat({
        employeeId: input.userId,
        threadId: input.threadId,
        text: input.text,
        inputModality: input.inputModality,
      });
      return {
        ...result,
        selectedProcessIds: result.selectedProcessIds.includes("inbox_capture") ? ["core", "inbox_capture"] : ["core"],
        outcome: { status: "completed" },
      };
    },
  };
}
