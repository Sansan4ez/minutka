import type { ConversationStore } from "./conversation-store.js";
import type { DocumentStore, UserDocument } from "./document-store.js";
import { assertUserId } from "./document-store.js";
import type { CaptureIdeaInput, CaptureIdeaResult, IngestionService } from "./ingestion-service.js";
import { NO_PROJECT } from "../domain/classification.js";
import { createAssistantContextProjectionBuilder, renderAssistantContextProjection, type AssistantContextProjection } from "./assistant-context-projection.js";
import { createAssistantRecordsProjectionBuilder, renderAssistantRecordsProjection, type AssistantRecordsProjection } from "./assistant-records-projection.js";
import type { IdeaSource, IdeaStore } from "./idea-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";

export type AssistantChatInput = { userId: string; threadId: string; text: string; source?: IdeaSource };
export type AssistantAgentContext = {
  systemContext: string;
  personalContext: AssistantContextProjection;
  records: AssistantRecordsProjection;
  /** Sanitized source metadata for capture; it contains no transport identity. */
  source: IdeaSource;
  /** Typed, reversible owner-scoped action; a runner must invoke this to save a classified idea. */
  captureIdea(input: Omit<CaptureIdeaInput, "id" | "userId">): Promise<CaptureIdeaResult>;
};
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext) => Promise<string>;
export type AssistantChatResult = { messageId: string; response: string; personalContextDocuments: string[] };

/**
 * Product-level orchestration for the personal assistant.
 * It intentionally owns no persistence implementation and never gives the
 * agent store credentials or a mutable filesystem.
 */
export class AssistantService {
  private readonly projectionBuilder;
  private readonly recordsProjectionBuilder?: ReturnType<typeof createAssistantRecordsProjectionBuilder>;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    private readonly agentRunner: AssistantAgentRunner,
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument" | "captureIdea">; ideaStore?: IdeaStore; clock?: Clock; idGenerator?: IdGenerator },
  ) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.projectionBuilder = createAssistantContextProjectionBuilder({ documentStore: deps.documentStore, now: () => this.clock.now() });
    this.recordsProjectionBuilder = deps.ideaStore === undefined ? undefined : createAssistantRecordsProjectionBuilder({ ideaStore: deps.ideaStore, now: () => this.clock.now() });
  }

  /** Explicit onboarding write: reviewed Markdown flows through the ingestion boundary. */
  async saveOnboardingContext(input: { userId: string; path: string; content: string }): Promise<UserDocument> {
    return this.deps.ingestionService.saveContextDocument(input);
  }

  async chat(input: AssistantChatInput): Promise<AssistantChatResult> {
    const userId = assertUserId(input.userId);
    const threadId = input.threadId.trim();
    const text = input.text.trim();
    const source = input.source ?? { kind: "text", text };
    if (!threadId) throw new Error("threadId is required");
    if (!text) throw new Error("text is required");
    const messageId = this.ids.messageId();
    const requestId = this.ids.requestId();
    const personalContext = await this.projectionBuilder.build({ userId, requestId });
    const records = await this.recordsProjectionBuilder?.build({ userId, requestId }) ?? emptyRecordsProjection({ userId, requestId, now: this.clock.now() });
    let captureResult: CaptureIdeaResult | undefined;
    const captureIdea = async (idea: Omit<CaptureIdeaInput, "id" | "userId">) => {
      captureResult = await this.deps.ingestionService.captureIdea({ ...idea, id: this.ids.ideaId(), userId });
      return captureResult;
    };
    const response = await this.agentRunner({ userId, threadId, text }, {
      personalContext,
      records,
      source,
      systemContext: buildAssistantSystemContext(personalContext, records),
      captureIdea,
    });
    // A provider failure or an answer that did not use the typed action must
    // never discard owner input. Capture a neutral raw record instead.
    if (!captureResult) {
      // Preserve the conversational response even when the optional Phase B
      // store is not part of an older runtime composition.
      await captureIdea({
        project: NO_PROJECT,
        type: "knowledge",
        summary: text,
        suggestedNextStep: "Уточнить проект и следующий шаг.",
        needsProjectClarification: true,
        source,
      }).catch(() => undefined);
    }
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

export function buildAssistantSystemContext(personalContext: AssistantContextProjection, records?: AssistantRecordsProjection): string {
  return [
    "# Personal assistant runtime context",
    "You are a personal assistant. Create useful drafts when requested, but never send external messages, publish, change a calendar, or make financial actions without an explicit confirmation step handled by the application.",
    "Facts such as names, prices, and deadlines must come from supplied context or be clarified; do not invent them.",
    renderAssistantContextProjection(personalContext),
    ...(records === undefined ? [] : [renderAssistantRecordsProjection(records)]),
  ].filter(Boolean).join("\n\n");
}

function emptyRecordsProjection(input: { userId: string; requestId: string; now: string }): AssistantRecordsProjection {
  return {
    schemaVersion: 1,
    path: "/proc/records",
    generatedAt: input.now,
    scope: { userId: input.userId, requestId: input.requestId },
    data: { records: [], truncated: false },
  };
}
