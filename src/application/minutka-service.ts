import type { AiLevel, OnboardingStatus, Persona, ResponseLengthPreference, UserProfile } from "../domain/employee.js";
import { currentPrivacyVersion, privacyExplanation } from "../domain/privacy.js";
import type { AgentManual, AgentManualProcessId, AgentManualPurpose } from "./agent-manual-types.js";
import { loadAgentManualFromDisk } from "./agent-manual-loader.js";
import { createMinutkaContextBuilder, type MinutkaContextBuilderLike } from "./minutka-context-builder.js";
import type { AgentManualRouter } from "./agent-manual-resolver.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";
import type { InsightExtractor } from "./insight-extractor.js";
import type { InsightStore } from "./insight-store.js";
import type { ProfileStore } from "./profile-store.js";
import { buildBoundaryResponse, sanitizeConversationDecision, type ConversationDecisionRouter } from "./conversation-decision-router.js";
import type { InsightKind, StructuredInsight, StructuredInsightDraft } from "../domain/insights.js";
import type { ConversationDecision } from "../domain/conversation-decision.js";
import type { FeedbackRating, FeedbackSource } from "../domain/feedback.js";
import type { FeedbackStore } from "./feedback-store.js";
import { safeAuditMetadata, type AuditEventStore, type AuditEventType, type SafeAuditMetadata } from "./audit-event-store.js";
import { PersistenceError } from "./persistence-error.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";
import type { ConsentAcceptanceStore } from "./consent-acceptance-store.js";
import type {
  TelegramIdentity,
  TelegramInviteRedemptionStore,
} from "./telegram-invite-redemption-store.js";
import type { RuntimeProjectionBuilder } from "./runtime-projections/runtime-projection-builder.js";
import { createRuntimeProjectionBuilder } from "./runtime-projections/runtime-projection-builder.js";

export type ChatInput = { employeeId: string; threadId: string; text: string };
export type ChatResult = { messageId: string; response: string; selectedProcessIds: AgentManualProcessId[] };
export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: AgentManualPurpose;
  decision?: ConversationDecision;
  selectedProcessIds?: AgentManualProcessId[];
};
export type AgentRunner = (input: ChatInput, context?: AgentRunContext) => Promise<string>;
export type IssueInviteInput = { employeeId: string; inviteCode: string };
export type IssueInviteResult = { employeeId: string; inviteCode: string; status: OnboardingStatus; created: boolean };
export type OpenInviteInput = { inviteCode: string };
export type RecordPrivacyExplanationShownInput = { employeeId: string };
export type RedeemTelegramInviteInput = {
  inviteCode: string;
  identity: TelegramIdentity;
};
export type RedeemTelegramInviteResult = {
  employeeId: string;
  threadId: string;
  privacyVersion: typeof currentPrivacyVersion;
  privacyExplanation: string;
};
export type OpenInviteResult = {
  employeeId: string;
  /** Returned only at the invite-operation boundary; never stored in Participant. */
  inviteCode: string;
  status: OnboardingStatus;
  privacyVersion: typeof currentPrivacyVersion;
  privacyExplanation: string;
};
export type AcceptConsentInput = { employeeId: string; accepted: true; source: "cli" | "telegram" | "test"; telegramIdentity?: TelegramIdentity };
export type AcceptConsentResult = { employeeId: string; privacyVersion: typeof currentPrivacyVersion; acceptedAt: string };
export type CompleteOnboardingInput = {
  employeeId: string; role: string; typicalTasks: string[]; persona: Persona; aiLevel: AiLevel;
  responseLength?: ResponseLengthPreference; preferredCheckinsPerDay?: 1 | 2 | 3;
};
export type CompleteOnboardingResult = { employeeId: string; status: "profile_completed"; profile: UserProfile; firstResponse: string };
export type ListInsightsInput = { employeeId?: string; threadId?: string; kind?: InsightKind };
export type SubmitFeedbackInput = {
  employeeId: string; threadId: string; targetMessageId: string; rating: FeedbackRating; source: FeedbackSource;
};
export type SubmitFeedbackResult = { accepted: true; feedbackId: string; selectedProcessIds: AgentManualProcessId[] };

export type MinutkaServiceDeps = {
  profileStore?: ProfileStore;
  conversationStore?: ConversationStore;
  insightStore?: InsightStore;
  feedbackStore?: FeedbackStore;
  auditEventStore?: AuditEventStore;
  clock?: Clock;
  idGenerator?: IdGenerator;
  insightExtractor?: InsightExtractor;
  contextBuilder?: MinutkaContextBuilderLike;
  projectionBuilder?: RuntimeProjectionBuilder;
  consentAcceptanceStore?: ConsentAcceptanceStore;
  telegramInviteRedemptionStore?: TelegramInviteRedemptionStore;
  agentManualRouter?: AgentManualRouter;
  conversationDecisionRouter?: ConversationDecisionRouter;
  manual?: AgentManual;
};

/** Transport- and storage-independent application use cases. */
export class MinutkaService {
  private readonly stores: {
    profileStore: ProfileStore;
    conversationStore: ConversationStore;
    insightStore: InsightStore;
    feedbackStore: FeedbackStore;
    auditEventStore: AuditEventStore;
  };
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly contextBuilder: MinutkaContextBuilderLike;
  private readonly projectionBuilder: RuntimeProjectionBuilder;
  private readonly manual: AgentManual;

  constructor(private readonly agentRunner: AgentRunner, private readonly deps: MinutkaServiceDeps) {
    this.stores = {
      profileStore: requireDependency(deps.profileStore, "profileStore"),
      conversationStore: requireDependency(deps.conversationStore, "conversationStore"),
      insightStore: requireDependency(deps.insightStore, "insightStore"),
      feedbackStore: requireDependency(deps.feedbackStore, "feedbackStore"),
      auditEventStore: requireDependency(deps.auditEventStore, "auditEventStore"),
    };
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.manual = deps.manual ?? loadAgentManualFromDisk();
    this.contextBuilder = deps.contextBuilder ?? createMinutkaContextBuilder(this.manual, deps.agentManualRouter);
    this.projectionBuilder = deps.projectionBuilder ?? createRuntimeProjectionBuilder({ ...this.stores, clock: this.clock });
  }

  async issueInvite(input: IssueInviteInput): Promise<IssueInviteResult> {
    const employeeId = input.employeeId.trim();
    const inviteCode = input.inviteCode.trim();
    if (!employeeId) throw new Error("employeeId is required");
    if (!inviteCode) throw new Error("inviteCode is required");
    const result = await this.stores.profileStore.issueInvite({ employeeId, inviteCode, issuedAt: this.clock.now() });
    if (result.participant.employeeId !== employeeId) throw new Error("invite already belongs to another employee");
    if (!result.created && !result.inviteMatches) throw new Error("employee already has an active invite");
    return { employeeId, inviteCode, status: result.participant.status, created: result.created };
  }

  async openInvite(input: OpenInviteInput): Promise<OpenInviteResult> {
    const inviteCode = input.inviteCode.trim();
    if (!inviteCode) throw new Error("inviteCode is required");
    const requestId = this.ids.requestId();
    const openedAt = this.clock.now();
    const opened = await this.stores.profileStore.openInvite({
      inviteCode, openedAt, explanationShownAt: this.clock.now(),
    });
    if (!opened) throw new PersistenceError("invite_not_found");
    if (opened.opened) await this.audit(requestId, "invite_opened", opened.participant.employeeId, undefined, undefined, openedAt);
    await this.audit(requestId, "privacy_explanation_shown", opened.participant.employeeId, undefined, undefined, this.clock.now(), {
      privacyVersion: currentPrivacyVersion,
    });
    return {
      employeeId: opened.participant.employeeId,
      inviteCode,
      status: opened.participant.status,
      privacyVersion: currentPrivacyVersion,
      privacyExplanation,
    };
  }

  async recordPrivacyExplanationShown(input: RecordPrivacyExplanationShownInput): Promise<void> {
    const employeeId = input.employeeId.trim();
    if (!employeeId) throw new Error("employeeId is required");
    const requestId = this.ids.requestId();
    const shownAt = this.clock.now();
    await this.stores.profileStore.recordPrivacyExplanationShown({ employeeId, shownAt });
    await this.audit(requestId, "privacy_explanation_shown", employeeId, undefined, undefined, shownAt, {
      privacyVersion: currentPrivacyVersion,
    });
  }

  async redeemTelegramInvite(input: RedeemTelegramInviteInput): Promise<RedeemTelegramInviteResult> {
    const inviteCode = input.inviteCode.trim();
    if (!inviteCode) throw new Error("inviteCode is required");
    const store = this.deps.telegramInviteRedemptionStore;
    if (!store) throw new Error("telegramInviteRedemptionStore is required for Telegram invite redemption");
    const requestId = this.ids.requestId();
    const occurredAt = this.clock.now();
    const result = await store.redeem({
      inviteCode,
      identity: input.identity,
      occurredAt,
      auditEvent: {
        id: this.ids.auditEventId(),
        requestId,
        type: "invite_opened",
        employeeId: undefined,
        occurredAt,
        metadata: {},
      },
    });
    if (result.status === "invite_not_found") throw new PersistenceError("invite_not_found");
    if (result.status === "employee_already_linked") throw new PersistenceError("employee_already_linked");
    if (result.status === "chat_already_linked") throw new PersistenceError("chat_already_linked");
    return {
      employeeId: result.employeeId,
      threadId: result.threadId,
      privacyVersion: currentPrivacyVersion,
      privacyExplanation,
    };
  }

  async acceptConsent(input: AcceptConsentInput): Promise<AcceptConsentResult> {
    if (input.accepted !== true) throw new Error("privacy consent must be explicitly accepted");
    const participant = await this.requireParticipant(input.employeeId);
    const requestId = this.ids.requestId();
    const timestamp = this.clock.now();
    const consent = {
      employeeId: input.employeeId,
      privacyVersion: currentPrivacyVersion,
      acceptedAt: timestamp,
      explanationShownAt: participant.privacyExplanationShownAt ?? timestamp,
      source: input.source,
    } as const;
    const claimed = this.deps.consentAcceptanceStore
      ? await this.deps.consentAcceptanceStore.accept({
          consent,
          auditEvent: {
            id: this.ids.auditEventId(),
            requestId,
            type: "consent_accepted",
            employeeId: participant.employeeId,
            occurredAt: timestamp,
            metadata: { privacyVersion: currentPrivacyVersion },
          },
          ...(input.telegramIdentity ? { telegramIdentity: input.telegramIdentity } : {}),
        })
      : await this.stores.profileStore.acceptConsent(consent);
    if (claimed.created && !this.deps.consentAcceptanceStore) {
      await this.audit(requestId, "consent_accepted", participant.employeeId, undefined, undefined, timestamp, { privacyVersion: currentPrivacyVersion });
    }
    return { employeeId: claimed.consent.employeeId, privacyVersion: claimed.consent.privacyVersion, acceptedAt: claimed.consent.acceptedAt };
  }

  async completeOnboarding(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
    await this.requireParticipant(input.employeeId);
    if (!await this.stores.profileStore.getConsent(input.employeeId)) throw new Error("consent is required before onboarding can be completed");
    this.validateProfileInput(input);
    const requestId = this.ids.requestId();
    const timestamp = this.clock.now();
    const existing = await this.stores.profileStore.getProfile(input.employeeId);
    const profile: UserProfile = {
      employeeId: input.employeeId, role: input.role.trim(), typicalTasks: input.typicalTasks.map((task) => task.trim()),
      persona: input.persona, aiLevel: input.aiLevel, responseLength: input.responseLength ?? "balanced",
      preferredCheckinsPerDay: input.preferredCheckinsPerDay, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    };
    const completed = await this.stores.profileStore.completeProfile({ profile, completedAt: timestamp });
    await this.audit(requestId, "profile_updated", input.employeeId, undefined, undefined, timestamp, { changedFields: getChangedFields(existing, profile) });
    if (!completed.wasCompleted) await this.audit(requestId, "onboarding_completed", input.employeeId, undefined, undefined, timestamp, { persona: input.persona });
    const built = await this.contextBuilder.build({ purpose: "onboarding_first_response", text: "Профиль онбординга заполнен. Дай короткое первое сообщение сотруднику.", profile });
    const firstResponse = await this.agentRunner({ employeeId: input.employeeId, threadId: input.employeeId, text: "Профиль онбординга заполнен. Дай короткое первое сообщение сотруднику." }, {
      profile, systemContext: built.systemContext, selectedProcessIds: built.selectedProcessIds, purpose: "onboarding_first_response",
    });
    return { employeeId: input.employeeId, status: "profile_completed", profile, firstResponse };
  }

  async getProfile(input: { employeeId: string }): Promise<UserProfile> {
    const profile = await this.stores.profileStore.getProfile(input.employeeId);
    if (!profile) throw new PersistenceError("profile_not_found");
    return profile;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const requestId = this.ids.requestId();
    const messageId = this.ids.messageId();
    const timestamp = this.clock.now();
    await this.audit(requestId, "chat_received", input.employeeId, input.threadId, messageId, timestamp);
    const snapshot = await this.projectionBuilder.buildProc({ ...input, requestId, purpose: "chat" });
    const profile = await this.stores.profileStore.getProfile(input.employeeId);
    const recentTurns = snapshot.thread.data.turns;
    const decision = await this.routeConversationDecisionSafely({ purpose: "chat", text: input.text, profile, recentTurns });
    const decisionProjection = this.projectionBuilder.buildDecision({ ...input, requestId, purpose: "chat" }, decision);
    const built = await this.contextBuilder.build({
      purpose: "chat",
      text: input.text,
      profile,
      recentTurns,
      runtimeProjection: snapshot,
      decisionProjection,
      selectedProcessIds: decision.selectedProcessIds,
    });
    let response: string;
    if (decision.workDecision.mode === "boundary") {
      response = buildBoundaryResponse(decision.workDecision, profile);
      await this.audit(requestId, "work_boundary_applied", input.employeeId, input.threadId, messageId, this.clock.now(), {
        reason: decision.workDecision.reason, selectedProcessIds: built.selectedProcessIds,
      });
    } else {
      response = await this.agentRunner(input, {
        ...(profile ? { profile } : {}),
        systemContext: built.systemContext,
        selectedProcessIds: built.selectedProcessIds, purpose: "chat", decision,
      });
    }
    await this.stores.conversationStore.appendTurn({ messageId, employeeId: input.employeeId, threadId: input.threadId, userText: input.text, agentResponse: response, timestamp });
    await this.audit(requestId, "chat_response_generated", input.employeeId, input.threadId, messageId, this.clock.now());
    if (decision.insightDecision.candidate) await this.extractInsights({ input, messageId, response, profile, recentTurns, decision, requestId });
    return { messageId, response, selectedProcessIds: built.selectedProcessIds };
  }

  async listInsights(input: ListInsightsInput): Promise<StructuredInsight[]> { return this.stores.insightStore.listInsights(input); }

  async submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
    await this.requireParticipant(input.employeeId);
    const message = await this.stores.conversationStore.getTurnByMessageId({ employeeId: input.employeeId, threadId: input.threadId, messageId: input.targetMessageId });
    if (!message) throw new Error(`Message not found or mismatch: ${input.targetMessageId}`);
    const requestId = this.ids.requestId();
    const profile = await this.stores.profileStore.getProfile(input.employeeId);
    const decision = await this.routeConversationDecisionSafely({ purpose: "feedback", text: "[structured-feedback]", profile, recentTurns: [] });
    const built = await this.contextBuilder.build({ purpose: "feedback", text: "[structured-feedback]", profile, selectedProcessIds: decision.selectedProcessIds });
    const saved = await this.stores.feedbackStore.saveFeedback({ id: this.ids.feedbackId(), ...input, updatedAt: this.clock.now() });
    await this.audit(requestId, "feedback_received", input.employeeId, input.threadId, input.targetMessageId, this.clock.now(), {
      feedbackId: saved.id, rating: input.rating, source: input.source, selectedProcessIds: built.selectedProcessIds,
    });
    return { accepted: true, feedbackId: saved.id, selectedProcessIds: built.selectedProcessIds };
  }

  private async extractInsights(input: { input: ChatInput; messageId: string; response: string; profile?: UserProfile; recentTurns: ConversationTurn[]; decision: ConversationDecision; requestId: string }) {
    try {
      if (!this.deps.insightExtractor) throw new Error("insightExtractor is required when decision enables insight extraction");
      const extraction = await this.deps.insightExtractor({ ...input.input, messageId: input.messageId, response: input.response, profile: input.profile, recentTurns: input.recentTurns, decision: input.decision });
      const insights = extraction.insights.map((draft) => ({ ...draft, id: this.ids.insightId(), createdAt: this.clock.now() } as StructuredInsight));
      await this.stores.insightStore.saveInsights(insights);
      for (const insight of insights) await this.audit(input.requestId, "insight_recorded", insight.employeeId, insight.threadId, insight.sourceMessageId, insight.createdAt, { insightId: insight.id, kind: insight.kind });
    } catch (error) {
      logOperationalError("insight extraction", error);
      try {
        await this.audit(input.requestId, "insight_extraction_failed", input.input.employeeId, input.input.threadId, input.messageId, this.clock.now());
      } catch (auditError) {
        logOperationalError("insight extraction audit", auditError);
      }
    }
  }

  private async audit(requestId: string, type: AuditEventType, employeeId: string, threadId: string | undefined, messageId: string | undefined, occurredAt: string, metadata: SafeAuditMetadata = {}) {
    await this.stores.auditEventStore.append({ id: this.ids.auditEventId(), requestId, type, employeeId, ...(threadId ? { threadId } : {}), ...(messageId ? { messageId } : {}), occurredAt, metadata: safeAuditMetadata(type, metadata) });
  }

  private async routeConversationDecisionSafely(input: { purpose: AgentManualPurpose; text: string; profile?: UserProfile; recentTurns: ConversationTurn[] }): Promise<ConversationDecision> {
    if (!this.deps.conversationDecisionRouter) throw new Error("conversationDecisionRouter is required for chat");
    try { return sanitizeConversationDecision(await this.deps.conversationDecisionRouter({ ...input, manual: this.manual }), this.manual, input.purpose); }
    catch { return sanitizeConversationDecision({ selectedProcessIds: ["core", "workday_guardrails"], workDecision: { mode: "boundary", reason: "unknown" }, insightDecision: { candidate: false, suggestedKinds: [] } }, this.manual, input.purpose); }
  }

  private async requireParticipant(employeeId: string) { const participant = await this.stores.profileStore.getParticipant(employeeId); if (!participant) throw new PersistenceError("participant_not_found"); return participant; }
  private validateProfileInput(input: CompleteOnboardingInput) { if (!input.role.trim()) throw new Error("role is required"); const tasks = input.typicalTasks.map((task) => task.trim()); if (tasks.length < 1 || tasks.length > 7 || tasks.some((task) => !task)) throw new Error("typicalTasks must contain 1 to 7 non-empty tasks"); }
}

const trackedProfileFields = ["role", "typicalTasks", "persona", "aiLevel", "responseLength", "preferredCheckinsPerDay"] as const;
function getChangedFields(existing: UserProfile | undefined, next: UserProfile): string[] {
  return trackedProfileFields.filter((field) =>
    // Omitted optional data is not a change on initial creation, while a later
    // removal from an existing profile remains visible in the audit trail.
    (field !== "preferredCheckinsPerDay" || existing?.[field] !== undefined || next[field] !== undefined)
    && (!existing || JSON.stringify(existing[field]) !== JSON.stringify(next[field])),
  );
}
/** Logs only the operation and error class; user data and driver payloads remain private. */
function logOperationalError(operation: string, error: unknown): void { console.warn(`Minutka ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
function requireDependency<T>(value: T | undefined, name: string): T { if (!value) throw new Error(`${name} is required; production composition has no in-memory fallback`); return value; }
