import type { ConversationStore } from "./conversation-store.js";
import type { DocumentStore, UserDocument } from "./document-store.js";
import { assertUserId } from "./document-store.js";
import type { IngestionService } from "./ingestion-service.js";
import { createAssistantContextProjectionBuilder, renderAssistantContextProjection, type AssistantContextProjection } from "./assistant-context-projection.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";

export type AssistantChatInput = { userId: string; threadId: string; text: string };
export type AssistantAgentContext = { systemContext: string; personalContext: AssistantContextProjection };
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext) => Promise<string>;
export type AssistantChatResult = { messageId: string; response: string; personalContextDocuments: string[] };

/**
 * Product-level orchestration for the personal assistant.
 * It intentionally owns no persistence implementation and never gives the
 * agent store credentials or a mutable filesystem.
 */
export class AssistantService {
  private readonly projectionBuilder;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    private readonly agentRunner: AssistantAgentRunner,
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument">; clock?: Clock; idGenerator?: IdGenerator },
  ) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.projectionBuilder = createAssistantContextProjectionBuilder({ documentStore: deps.documentStore, now: () => this.clock.now() });
  }

  /** Explicit onboarding write: reviewed Markdown flows through the ingestion boundary. */
  async saveOnboardingContext(input: { userId: string; path: string; content: string }): Promise<UserDocument> {
    return this.deps.ingestionService.saveContextDocument(input);
  }

  async chat(input: AssistantChatInput): Promise<AssistantChatResult> {
    const userId = assertUserId(input.userId);
    const threadId = input.threadId.trim();
    const text = input.text.trim();
    if (!threadId) throw new Error("threadId is required");
    if (!text) throw new Error("text is required");
    const messageId = this.ids.messageId();
    const requestId = this.ids.requestId();
    const personalContext = await this.projectionBuilder.build({ userId, requestId });
    const response = await this.agentRunner({ userId, threadId, text }, {
      personalContext,
      systemContext: buildAssistantSystemContext(personalContext),
    });
    await this.deps.conversationStore.appendTurn({
      messageId,
      // The existing application history store uses employeeId as its neutral
      // owner key. AssistantService maps its trusted userId only at this seam.
      employeeId: userId,
      threadId,
      userText: text,
      agentResponse: response,
      timestamp: this.clock.now(),
    });
    return { messageId, response, personalContextDocuments: personalContext.data.documents.map((document) => document.path) };
  }
}

export function buildAssistantSystemContext(personalContext: AssistantContextProjection): string {
  return [
    "# Personal assistant runtime context",
    "You are a personal assistant. Create useful drafts when requested, but never send external messages, publish, change a calendar, or make financial actions without an explicit confirmation step handled by the application.",
    "Facts such as names, prices, and deadlines must come from supplied context or be clarified; do not invent them.",
    renderAssistantContextProjection(personalContext),
  ].filter(Boolean).join("\n\n");
}
