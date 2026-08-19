import type { AddressForm, AiLevel, Consent, OnboardingStatus, Participant, Persona, ResponseLengthPreference, UserProfile } from "../domain/employee.js";
import { currentPrivacyVersion } from "../domain/privacy.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import type { AgentManual, AgentManualProcessId, AgentManualPurpose } from "./agent-manual-types.js";
import { loadAgentManualFromDisk } from "./agent-manual-loader.js";
import { createMinutkaContextBuilder, type MinutkaContextBuilderLike } from "./minutka-context-builder.js";
import type { AgentManualRouter } from "./agent-manual-resolver.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";
import type { InsightExtractor } from "./insight-extractor.js";
import type { InsightStore } from "./insight-store.js";
import type { ProfileStore } from "./profile-store.js";
import type { TenantDirectoryStore } from "./tenant-directory-store.js";
import type { OnboardingDraftStore } from "./onboarding-draft-store.js";
import type { OnboardingProfileExtraction, OnboardingProfileExtractor } from "./onboarding-profile-extractor.js";
import type { UsageRecorder } from "./usage-recorder.js";
import { extractDeterministicOnboardingPatch, normalizeOnboardingProfilePatch } from "./onboarding-profile-extractor.js";
import type { OnboardingDraft, OnboardingProfilePatch, OnboardingProgress } from "./onboarding-types.js";
import type { OnboardingContextMaterializer } from "./onboarding-context-materializer.js";
import { buildBoundaryResponse, sanitizeConversationDecision, type ConversationDecisionRouter } from "./conversation-decision-router.js";
import type { InsightKind, StructuredInsight } from "../domain/insights.js";
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
import type { ChatInputModality, ResponseChannel } from "../contracts/minutka-api.js";
import { createResponsePolicy, renderResponsePolicy } from "../domain/response-policy.js";
import type { DefaultScheduleProvisioner, DefaultScheduleProvisionResult } from "./default-schedules.js";
import { createOnboardingWelcome } from "./onboarding-welcome-loader.js";
import { decodeParticipantCursor, encodeParticipantCursor, type ListParticipantsInput } from "./participant-pagination.js";
import { ParticipantInviteExistsError } from "./participant-invite-error.js";
import { RoleNotInCompanyError } from "./onboarding-role-error.js";
import type { ResearchSubject } from "./research-identity-projection.js";
import { participantEngagement, type ParticipantEngagement } from "./participant-engagement.js";
import { normalizePersonalProfileContextPatch } from "./personal-profile-context.js";
import { PersonalContextReviewService, type PersonalContextPatch, type PersonalContextUpdateResult, type PersonalContextView } from "./personal-context-review.js";

export type ChatInput = { employeeId: string; threadId: string; text: string; inputModality?: ChatInputModality; responseChannel?: ResponseChannel };
export type ChatResult = { messageId: string; response: string; selectedProcessIds: AgentManualProcessId[]; pendingActions: []; effect: "none" };
export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: AgentManualPurpose;
  decision?: ConversationDecision;
  selectedProcessIds?: AgentManualProcessId[];
};
export type AgentRunner = (input: ChatInput, context?: AgentRunContext) => Promise<string>;
export type IssueInviteInput = { employeeId: string; inviteCode: string; companyId: string; groupId: string };
export type IssueInviteResult = { employeeId: string; inviteCode: string; companyId: string; groupId: string; status: OnboardingStatus; created: boolean };
export type ParticipantSummary = Pick<Participant, "employeeId" | "status" | "lastTouchOn"> & { engagement: ParticipantEngagement };
export type ParticipantPage = { participants: ParticipantSummary[]; nextCursor?: string };
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
  employeeId: string;
  preferredName?: string; assistantName?: string; addressForm?: AddressForm; timezone?: string;
  persona: Persona; responseLength?: ResponseLengthPreference; preferredCheckinsPerDay?: 1 | 2 | 3;
  roleId: string;
  selfDescription?: string;
  typicalTasks?: string[];
  aiLevel?: AiLevel;
  programGoal?: string;
};
export type CompleteOnboardingResult = { employeeId: string; status: "profile_completed"; completion: "new" | "already"; profile: UserProfile; firstResponse: string; firstActivityPrompt?: string };
export type GetOnboardingProgressInput = { employeeId: string };
export type SubmitOnboardingAnswerInput = { employeeId: string; text: string };
export type ConfirmOnboardingInput = { employeeId: string };
export type ResetOnboardingDraftInput = { employeeId: string };
export type { OnboardingField, OnboardingDraft, OnboardingProfilePatch, OnboardingProgress } from "./onboarding-types.js";
export type ListInsightsInput = { employeeId?: string; threadId?: string; kind?: InsightKind };
export type SubmitFeedbackInput = {
  employeeId: string; threadId: string; targetMessageId: string; rating: FeedbackRating; source: FeedbackSource;
};
export type SubmitFeedbackResult = { accepted: true; feedbackId: string; selectedProcessIds: AgentManualProcessId[] };
export type GetPersonalContextInput = { employeeId: string };
export type UpdatePersonalContextInput = { employeeId: string; patch: PersonalContextPatch };

const defaultOnboardingExtractionTimeoutMs = 20_000;

export type MinutkaServiceDeps = {
  profileStore?: ProfileStore;
  tenantDirectoryStore?: TenantDirectoryStore;
  onboardingDraftStore?: OnboardingDraftStore;
  onboardingProfileExtractor?: OnboardingProfileExtractor;
  onboardingContextMaterializer?: OnboardingContextMaterializer;
  /** Bounds provider latency; extraction always falls back before the HTTP budget expires. */
  onboardingExtractionTimeoutMs?: number;
  usageRecorder?: UsageRecorder;
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
  /** Exact versioned text shown before accepting the current privacy version. */
  privacyExplanation?: string;
  defaultScheduleProvisioner?: DefaultScheduleProvisioner;
  /** Deterministic welcome renderer; production and the legacy path use the same Vault source. */
  onboardingWelcome?: typeof createOnboardingWelcome;
};

/** Transport- and storage-independent application use cases. */
export class MinutkaService {
  private readonly stores: {
    profileStore: ProfileStore;
    tenantDirectoryStore: TenantDirectoryStore;
    onboardingDraftStore: OnboardingDraftStore;
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
  private readonly privacyExplanation: string;

  constructor(private readonly agentRunner: AgentRunner, private readonly deps: MinutkaServiceDeps) {
    this.stores = {
      profileStore: requireDependency(deps.profileStore, "profileStore"),
      tenantDirectoryStore: requireDependency(deps.tenantDirectoryStore, "tenantDirectoryStore"),
      onboardingDraftStore: requireDependency(deps.onboardingDraftStore, "onboardingDraftStore"),
      conversationStore: requireDependency(deps.conversationStore, "conversationStore"),
      insightStore: requireDependency(deps.insightStore, "insightStore"),
      feedbackStore: requireDependency(deps.feedbackStore, "feedbackStore"),
      auditEventStore: requireDependency(deps.auditEventStore, "auditEventStore"),
    };
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.manual = deps.manual ?? loadAgentManualFromDisk();
    this.privacyExplanation = requireStringDependency(deps.privacyExplanation, "privacyExplanation");
    this.contextBuilder = deps.contextBuilder ?? createMinutkaContextBuilder(this.manual, deps.agentManualRouter);
    this.projectionBuilder = deps.projectionBuilder ?? createRuntimeProjectionBuilder({ ...this.stores, clock: this.clock });
  }

  async issueInvite(input: IssueInviteInput): Promise<IssueInviteResult> {
    const employeeId = input.employeeId.trim();
    const inviteCode = input.inviteCode.trim();
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!employeeId) throw new Error("employeeId is required");
    if (!inviteCode) throw new Error("inviteCode is required");
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");
    if (!await this.stores.tenantDirectoryStore.groupBelongsToCompany({ companyId, groupId })) throw new Error("group does not belong to company");
    const result = await this.stores.profileStore.issueInvite({ employeeId, inviteCode, companyId, groupId, issuedAt: this.clock.now() });
    if (result.participant.employeeId !== employeeId) throw new Error("invite already belongs to another employee");
    if (!result.created && !result.inviteMatches) throw new ParticipantInviteExistsError();
    if ((result.participant.companyId && result.participant.companyId !== companyId) || (result.participant.groupId && result.participant.groupId !== groupId)) throw new Error("employee already has an invite for another tenant");
    return { employeeId, inviteCode, companyId, groupId, status: result.participant.status, created: result.created };
  }

  async listResearchSubjects(input: { companyId: string; groupId: string }): Promise<ResearchSubject[]> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");
    if (!await this.stores.tenantDirectoryStore.groupBelongsToCompany({ companyId, groupId })) return [];
    return this.stores.profileStore.listResearchSubjects({ companyId, groupId });
  }

  async getResearchSubject(input: { companyId: string; groupId: string; subjectKey: string }): Promise<ResearchSubject | undefined> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    const subjectKey = input.subjectKey.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");
    if (!subjectKey) throw new Error("subjectKey is required");
    if (!await this.stores.tenantDirectoryStore.groupBelongsToCompany({ companyId, groupId })) return undefined;
    return this.stores.profileStore.getResearchSubject({ companyId, groupId, subjectKey });
  }

  async listParticipants(input: ListParticipantsInput): Promise<ParticipantPage> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");
    const limit = input.limit ?? 20;
    const after = input.after === undefined ? undefined : decodeParticipantCursor(input.after);
    const page = await this.stores.profileStore.listParticipants({ companyId, groupId, limit: limit + 1, after });
    const participants = page.slice(0, limit);
    const last = participants.at(-1);
    const now = this.clock.now();
    const summaries = await Promise.all(participants.map(async ({ employeeId, status, lastTouchOn }) => {
      const timezone = (await this.stores.profileStore.getProfile(employeeId))?.timezone ?? "Etc/UTC";
      return {
        employeeId,
        status,
        ...(lastTouchOn ? { lastTouchOn } : {}),
        engagement: participantEngagement({ lastTouchOn, now, timezone }),
      };
    }));
    return {
      participants: summaries,
      ...(page.length > limit && last ? { nextCursor: encodeParticipantCursor({ createdAt: last.createdAt, employeeId: last.employeeId }) } : {}),
    };
  }

  async openInvite(input: OpenInviteInput): Promise<OpenInviteResult> {
    const inviteCode = input.inviteCode.trim();
    if (!inviteCode) throw new Error("inviteCode is required");
    const requestId = this.ids.requestId();
    const openedAt = this.clock.now();
    const explanationShownAt = this.clock.now();
    const opened = await this.stores.profileStore.openInvite({
      inviteCode, openedAt, explanationShownAt,
    });
    if (!opened) throw new PersistenceError("invite_not_found");
    if (!opened.opened) await this.stores.profileStore.recordPrivacyExplanationShown({ employeeId: opened.participant.employeeId, shownAt: explanationShownAt });
    if (opened.opened) await this.audit(requestId, "invite_opened", opened.participant.employeeId, undefined, undefined, openedAt);
    await this.audit(requestId, "privacy_explanation_shown", opened.participant.employeeId, undefined, undefined, explanationShownAt, {
      privacyVersion: currentPrivacyVersion,
    });
    return {
      employeeId: opened.participant.employeeId,
      inviteCode,
      status: opened.participant.status,
      privacyVersion: currentPrivacyVersion,
      privacyExplanation: this.privacyExplanation,
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
      privacyExplanation: this.privacyExplanation,
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
    if (claimed.consent.privacyVersion !== currentPrivacyVersion) throw new PersistenceError("persistence_conflict");
    return { employeeId: claimed.consent.employeeId, privacyVersion: currentPrivacyVersion, acceptedAt: claimed.consent.acceptedAt };
  }

  async completeOnboarding(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
    return this.completeOnboardingProfile(input, true);
  }

  private async completeOnboardingProfile(input: CompleteOnboardingInput, allowUpdate: boolean): Promise<CompleteOnboardingResult> {
    const participant = await this.requireParticipant(input.employeeId);
    if (!hasCurrentConsent(await this.stores.profileStore.getConsent(input.employeeId))) throw new PersistenceError("consent_required");
    this.validateProfileInput(input);
    const companyId = participant.companyId;
    const groupId = participant.groupId;
    const roleId = input.roleId.trim();
    if (!await this.stores.tenantDirectoryStore.getRole({ companyId, roleId })) throw new RoleNotInCompanyError();
    const normalizedTimezone = input.timezone === undefined ? undefined : normalizeIanaTimezone(input.timezone);
    const requestId = this.ids.requestId();
    const timestamp = this.clock.now();
    const existing = await this.stores.profileStore.getProfile(input.employeeId);
    const personalContext = normalizePersonalProfileContextPatch({ typicalTasks: input.typicalTasks, aiLevel: input.aiLevel, programGoal: input.programGoal });
    const profile: UserProfile = {
      employeeId: input.employeeId,
      companyId,
      groupId,
      roleId,
      preferredName: input.preferredName?.trim() || existing?.preferredName || input.employeeId,
      assistantName: input.assistantName?.trim() || existing?.assistantName || "Минутка",
      addressForm: input.addressForm ?? existing?.addressForm ?? "informal",
      persona: input.persona,
      responseLength: input.responseLength ?? "balanced",
      timezone: normalizedTimezone ?? existing?.timezone ?? "Etc/UTC",
      ...(input.selfDescription?.trim() ? { role: input.selfDescription.trim() } : existing?.role ? { role: existing.role } : {}),
      ...(personalContext.typicalTasks ? { typicalTasks: personalContext.typicalTasks } : existing?.typicalTasks ? { typicalTasks: existing.typicalTasks } : {}),
      ...(personalContext.aiLevel ? { aiLevel: personalContext.aiLevel } : existing?.aiLevel ? { aiLevel: existing.aiLevel } : {}),
      ...(personalContext.programGoal ? { programGoal: personalContext.programGoal } : existing?.programGoal ? { programGoal: existing.programGoal } : {}),
      preferredCheckinsPerDay: input.preferredCheckinsPerDay,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const changedFields = getChangedFields(existing, profile);
    if (allowUpdate && existing && changedFields.length === 0) {
      await this.materializeOnboardingContext(input.employeeId);
      await this.deleteOnboardingDraftSafely(input.employeeId);
      await this.provisionDefaultSchedules(existing);
      return { employeeId: input.employeeId, status: "profile_completed", completion: "already", profile: existing, firstResponse: "Профиль уже сохранён." };
    }
    // Context documents are persisted before the profile completion marker. If
    // document storage fails, confirmation remains retryable and no completed
    // profile can hide missing required context.
    await this.materializeOnboardingContext(input.employeeId);
    // Profile completion and draft removal are one storage transaction. This
    // makes the finalized profile the source of truth even under stale writes.
    const completed = await this.stores.profileStore.completeProfile({ profile, completedAt: timestamp, allowUpdate, deleteOnboardingDraft: true });
    const provisionedSchedules = await this.provisionDefaultSchedules(completed.profile);
    if (completed.wasCompleted && !allowUpdate) return { employeeId: input.employeeId, status: "profile_completed", completion: "already", profile: completed.profile, firstResponse: "Профиль уже сохранён." };
    await this.auditProfileCompletionSafely({ requestId, employeeId: input.employeeId, timestamp, changedFields, persona: completed.profile.persona, isNewProfile: !completed.wasCompleted });
    if (completed.wasCompleted) return { employeeId: input.employeeId, status: "profile_completed", completion: "new", profile: completed.profile, firstResponse: "Профиль обновлён." };
    const firstResponse = this.createFirstOnboardingResponse(completed.profile, provisionedSchedules);
    return {
      employeeId: input.employeeId,
      status: "profile_completed",
      completion: "new",
      profile: completed.profile,
      firstResponse,
      firstActivityPrompt: "Чем вы сегодня занимались? Достаточно пары строк.",
    };
  }

  async getOnboardingProgress(input: GetOnboardingProgressInput): Promise<OnboardingProgress> {
    const employeeId = input.employeeId.trim();
    await this.requireParticipant(employeeId);
    if (!hasCurrentConsent(await this.stores.profileStore.getConsent(employeeId))) throw new PersistenceError("consent_required");
    if (await this.stores.profileStore.getProfile(employeeId)) throw new PersistenceError("profile_already_completed");
    return this.onboardingProgressWithRoles(await this.getOrCreateOnboardingDraft(employeeId));
  }

  async submitOnboardingAnswer(input: SubmitOnboardingAnswerInput): Promise<OnboardingProgress> {
    const employeeId = input.employeeId.trim();
    const text = input.text.trim();
    if (!text) throw new Error("onboarding answer is required");
    await this.requireParticipant(employeeId);
    if (!hasCurrentConsent(await this.stores.profileStore.getConsent(employeeId))) throw new PersistenceError("consent_required");
    if (await this.stores.profileStore.getProfile(employeeId)) throw new PersistenceError("profile_already_completed");
    const current = await this.getOrCreateOnboardingDraft(employeeId);
    if (current.pendingField === "roleId") return this.selectOnboardingRole(current, text);
    if (current.status === "awaiting_confirmation" && isCompleteOnboardingDraft(current)) {
      if (isAffirmativeOnboardingAnswer(text)) return { status: "completed", result: await this.confirmOnboarding({ employeeId }) };
      if (isNegativeOnboardingAnswer(text)) return { status: "needs_correction", prompt: onboardingCorrectionPrompt };
    }
    let extracted: OnboardingProfileExtraction;
    const extractionTimeoutMs = this.deps.onboardingExtractionTimeoutMs ?? defaultOnboardingExtractionTimeoutMs;
    const extractionStartedAt = Date.now();
    try {
      extracted = this.deps.onboardingProfileExtractor
        ? await extractOnboardingPatchWithTimeout(this.deps.onboardingProfileExtractor, { text, currentDraft: current }, extractionTimeoutMs)
        : extractDeterministicOnboardingPatch({ text, currentDraft: current });
    } catch (error) {
      if (isOnboardingExtractorTimeout(error)) {
        console.warn(`Minutka onboarding profile extraction timed out (employeeId=${employeeId}; waitedMs=${Date.now() - extractionStartedAt}; timeoutMs=${extractionTimeoutMs}).`);
      } else {
        logOperationalError("onboarding profile extraction", error);
      }
      extracted = extractDeterministicOnboardingPatch({ text, currentDraft: current });
    }
    // Extraction runs on every onboarding answer, so it is a recurring spend of
    // the owner contour and needs its own attributed usage row.
    if (extracted.usage) {
      await this.deps.usageRecorder?.record({
        userId: employeeId,
        requestId: this.ids.requestId(),
        source: "onboarding",
        usage: extracted.usage,
      });
    }
    const fallback = extractDeterministicOnboardingPatch({ text, currentDraft: current });
    const patch = normalizeOnboardingProfilePatch(mergePatches(extracted, fallback));
    let draft = current;
    // A second Telegram delivery may have filled a different field while the
    // extractor was running. Re-merge the same bounded patch once instead of
    // dropping either answer or overwriting the newer draft.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Confirmation may have committed while extraction was in flight. Never
      // recreate or retain temporary personal data after that final transition.
      if (await this.stores.profileStore.getProfile(employeeId)) throw new PersistenceError("profile_already_completed");
      const next = makeOnboardingDraft(draft, mergeOnboardingPatch(draft, patch), this.clock.now());
      try {
        const saved = await this.stores.onboardingDraftStore.save(next, draft.revision);
        return this.onboardingProgressWithRoles(saved).then((progress) => current.pendingField === "timezone" && patch.timezone === undefined ? onboardingProgress(saved, true) : progress);
      }
      catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "persistence_conflict" || attempt === 1) throw error;
        if (await this.stores.profileStore.getProfile(employeeId)) throw new PersistenceError("profile_already_completed");
        const refreshed = await this.stores.onboardingDraftStore.get(employeeId);
        if (!refreshed) {
          // The draft expired while extraction was in progress. Start from an
          // empty generation so stale fields can never be revived by this save.
          draft = await this.getOrCreateOnboardingDraft(employeeId);
          continue;
        }
        // A reset starts a new collection generation. Never replay an answer
        // that was already in flight when the user discarded the old draft.
        if (refreshed.createdAt !== current.createdAt) return this.onboardingProgressWithRoles(refreshed);
        draft = refreshed;
      }
    }
    throw new Error("unreachable onboarding draft save");
  }

  async confirmOnboarding(input: ConfirmOnboardingInput): Promise<CompleteOnboardingResult> {
    const employeeId = input.employeeId.trim();
    await this.requireParticipant(employeeId);
    if (!hasCurrentConsent(await this.stores.profileStore.getConsent(employeeId))) throw new PersistenceError("consent_required");
    const existingProfile = await this.stores.profileStore.getProfile(employeeId);
    if (existingProfile) {
      await this.materializeOnboardingContext(employeeId);
      await this.deleteOnboardingDraftSafely(employeeId);
      await this.provisionDefaultSchedules(existingProfile);
      return { employeeId, status: "profile_completed", completion: "already", profile: existingProfile, firstResponse: "Профиль уже сохранён." };
    }
    const draft = await this.stores.onboardingDraftStore.get(employeeId);
    if (!draft || draft.status !== "awaiting_confirmation" || !isCompleteOnboardingDraft(draft)) throw new Error("onboarding draft is incomplete");
    return this.completeOnboardingProfile({ employeeId, roleId: draft.roleId, preferredName: draft.preferredName, addressForm: draft.addressForm, persona: draft.persona, timezone: draft.timezone }, false);
  }

  async resetOnboardingDraft(input: ResetOnboardingDraftInput): Promise<OnboardingProgress> {
    const employeeId = input.employeeId.trim();
    await this.requireParticipant(employeeId);
    if (!hasCurrentConsent(await this.stores.profileStore.getConsent(employeeId))) throw new PersistenceError("consent_required");
    if (await this.stores.profileStore.getProfile(employeeId)) throw new PersistenceError("profile_already_completed");
    const now = this.clock.now();
    const current = await this.stores.onboardingDraftStore.get(employeeId);
    // An explicit reset intentionally wins over an in-flight answer; keeping
    // revisions monotonic prevents that stale CAS write from reviving old data.
    const draft: OnboardingDraft = { employeeId, status: "collecting", pendingField: "roleId", revision: (current?.revision ?? 0) + 1, createdAt: now, updatedAt: now, expiresAt: onboardingExpiry(now) };
    return this.onboardingProgressWithRoles(await this.stores.onboardingDraftStore.replace(draft));
  }

  private async selectOnboardingRole(current: OnboardingDraft, roleInput: string): Promise<OnboardingProgress> {
    const participant = await this.requireParticipant(current.employeeId);
    const companyId = participant.companyId;
    const roles = await this.stores.tenantDirectoryStore.listRoles(companyId);
    const normalizedInput = roleInput.trim();
    const roleById = roles.find((role) => role.id === normalizedInput);
    const rolesByName = roles.filter((role) => role.name.localeCompare(normalizedInput, "ru", { sensitivity: "accent" }) === 0);
    const selectedRole = roleById ?? (rolesByName.length === 1 ? rolesByName[0] : undefined);
    if (!selectedRole) return this.roleSelectionProgress(roles, true);
    const next = makeOnboardingDraft(current, {
      roleId: selectedRole.id,
      preferredName: current.preferredName,
      assistantName: current.assistantName,
      addressForm: current.addressForm,
      persona: current.persona,
      responseLength: current.responseLength,
      timezone: current.timezone,
    }, this.clock.now());
    return this.onboardingProgressWithRoles(await this.stores.onboardingDraftStore.save(next, current.revision));
  }

  private async onboardingProgressWithRoles(draft: OnboardingDraft): Promise<OnboardingProgress> {
    const participant = await this.requireParticipant(draft.employeeId);
    const companyId = participant.companyId;
    if (draft.pendingField === "roleId") return this.roleSelectionProgress(await this.stores.tenantDirectoryStore.listRoles(companyId));
    if (isCompleteOnboardingDraft(draft)) {
      const role = await this.stores.tenantDirectoryStore.getRole({ companyId, roleId: draft.roleId });
      if (!role) throw new Error("roleId must belong to the participant company");
      return onboardingProgress(draft, false, role.name);
    }
    return onboardingProgress(draft);
  }

  private roleSelectionProgress(roles: Awaited<ReturnType<TenantDirectoryStore["listRoles"]>>, unrecognized = false): OnboardingProgress {
    if (roles.length === 0) throw new Error("participant company has no roles");
    return {
      status: "needs_choice",
      field: "roleId",
      prompt: unrecognized ? "Не нашёл такую должность. Выберите должность из списка." : "Выберите вашу должность.",
      choices: roles.map((role) => role.name),
      choiceValues: roles.map((role) => role.id),
      allowFreeText: true,
    };
  }

  private async provisionDefaultSchedules(profile: UserProfile): Promise<DefaultScheduleProvisionResult> {
    const provisioner = requireDependency(this.deps.defaultScheduleProvisioner, "defaultScheduleProvisioner");
    return provisioner.provision(profile.employeeId, profile.timezone);
  }

  async getProfile(input: { employeeId: string }): Promise<UserProfile> {
    const profile = await this.stores.profileStore.getProfile(input.employeeId);
    if (!profile) throw new PersistenceError("profile_not_found");
    return profile;
  }

  async getPersonalContext(input: GetPersonalContextInput): Promise<PersonalContextView> {
    return this.personalContextReview().get(input.employeeId);
  }

  async updatePersonalContext(input: UpdatePersonalContextInput): Promise<PersonalContextUpdateResult> {
    const result = await this.personalContextReview().update(input.employeeId, input.patch);
    await this.audit(this.ids.requestId(), "profile_updated", input.employeeId, undefined, undefined, this.clock.now(), { changedFields: result.changedFields });
    return result;
  }

  private personalContextReview(): PersonalContextReviewService {
    return new PersonalContextReviewService(this.stores.profileStore, this.stores.tenantDirectoryStore, this.clock);
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const requestId = this.ids.requestId();
    const messageId = this.ids.messageId();
    const timestamp = this.clock.now();
    const inputModality = input.inputModality ?? "text";
    const chatInput = { ...input, inputModality };
    await this.audit(requestId, "chat_received", input.employeeId, input.threadId, messageId, timestamp, { inputModality });
    const { snapshot, profile } = await this.projectionBuilder.buildChatProc({ ...chatInput, requestId, purpose: "chat" });
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
      responsePolicyContext: renderResponsePolicy(createResponsePolicy({ channel: input.responseChannel, preferredLength: profile?.responseLength })),
    });
    let response: string;
    if (decision.workDecision.mode === "boundary") {
      response = buildBoundaryResponse(decision.workDecision, profile);
      await this.audit(requestId, "work_boundary_applied", input.employeeId, input.threadId, messageId, this.clock.now(), {
        reason: decision.workDecision.reason, selectedProcessIds: built.selectedProcessIds,
      });
    } else {
      response = await this.agentRunner(chatInput, {
        ...(profile ? { profile } : {}),
        systemContext: built.systemContext,
        selectedProcessIds: built.selectedProcessIds, purpose: "chat", decision,
      });
    }
    await this.stores.conversationStore.appendTurn({ messageId, employeeId: input.employeeId, subjectKey: (await this.requireParticipant(input.employeeId)).subjectKey, threadId: input.threadId, userText: input.text, agentResponse: response, timestamp });
    // The turn is durable at this point. An audit outage must not turn a
    // successful response into a retry that duplicates the conversation.
    try {
      await this.audit(requestId, "chat_response_generated", input.employeeId, input.threadId, messageId, this.clock.now());
    } catch (error) {
      logOperationalError("chat response audit", error);
    }
    if (decision.insightDecision.candidate) await this.extractInsights({ input: chatInput, messageId, response, profile, recentTurns, decision, requestId });
    return { messageId, response, selectedProcessIds: built.selectedProcessIds, pendingActions: [], effect: "none" };
  }

  async listInsights(input: ListInsightsInput): Promise<StructuredInsight[]> { return this.stores.insightStore.listInsights(input); }

  async submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
    await this.requireParticipant(input.employeeId);
    const message = await this.stores.conversationStore.getTurnByMessageId({ employeeId: input.employeeId, threadId: input.threadId, messageId: input.targetMessageId });
    if (!message) throw new PersistenceError("message_not_found");
    const requestId = this.ids.requestId();
    // Rating callbacks already contain the complete typed intent. Persist them
    // directly; no agent process is selected or executed on this path.
    const selectedProcessIds: AgentManualProcessId[] = [];
    const saved = await this.stores.feedbackStore.saveFeedback({ id: this.ids.feedbackId(), ...input, updatedAt: this.clock.now() });
    await this.audit(requestId, "feedback_received", input.employeeId, input.threadId, input.targetMessageId, this.clock.now(), {
      feedbackId: saved.id, rating: input.rating, source: input.source,
    });
    return { accepted: true, feedbackId: saved.id, selectedProcessIds };
  }

  private async extractInsights(input: { input: ChatInput; messageId: string; response: string; profile?: UserProfile; recentTurns: ConversationTurn[]; decision: ConversationDecision; requestId: string }) {
    let insights: StructuredInsight[];
    try {
      if (!this.deps.insightExtractor) throw new Error("insightExtractor is required when decision enables insight extraction");
      const extraction = await this.deps.insightExtractor({ ...input.input, messageId: input.messageId, response: input.response, profile: input.profile, recentTurns: input.recentTurns, decision: input.decision });
      insights = extraction.insights.map((draft) => ({ ...draft, id: this.ids.insightId(), createdAt: this.clock.now() } as StructuredInsight));
      await this.stores.insightStore.saveInsights(insights);
    } catch (error) {
      logOperationalError("insight extraction", error);
      try {
        await this.audit(input.requestId, "insight_extraction_failed", input.input.employeeId, input.input.threadId, input.messageId, this.clock.now());
      } catch (auditError) {
        logOperationalError("insight extraction failure audit", auditError);
      }
      return;
    }
    try {
      for (const insight of insights) {
        await this.audit(input.requestId, "insight_recorded", insight.employeeId, insight.threadId, insight.sourceMessageId, insight.createdAt, { insightId: insight.id, kind: insight.kind });
      }
    } catch (error) {
      // Insights have already committed, so recording extraction_failed here
      // would create a contradictory audit trail. Preserve the failure signal.
      logOperationalError("insight audit", error);
    }
  }

  private async audit(requestId: string, type: AuditEventType, employeeId: string, threadId: string | undefined, messageId: string | undefined, occurredAt: string, metadata: SafeAuditMetadata = {}) {
    await this.stores.auditEventStore.append({ id: this.ids.auditEventId(), requestId, type, employeeId, ...(threadId ? { threadId } : {}), ...(messageId ? { messageId } : {}), occurredAt, metadata: safeAuditMetadata(type, metadata) });
  }

  private async materializeOnboardingContext(employeeId: string): Promise<void> {
    await this.deps.onboardingContextMaterializer?.materialize({ userId: employeeId });
  }

  private async deleteOnboardingDraftSafely(employeeId: string): Promise<void> {
    try { await this.stores.onboardingDraftStore.delete(employeeId); }
    catch (error) { logOperationalError("onboarding draft cleanup", error); }
  }

  private async auditProfileCompletionSafely(input: { requestId: string; employeeId: string; timestamp: string; changedFields: string[]; persona: Persona; isNewProfile: boolean }): Promise<void> {
    try { await this.audit(input.requestId, "profile_updated", input.employeeId, undefined, undefined, input.timestamp, { changedFields: input.changedFields }); }
    catch (error) { logOperationalError("profile completion audit", error); }
    if (!input.isNewProfile) return;
    try { await this.audit(input.requestId, "onboarding_completed", input.employeeId, undefined, undefined, input.timestamp, { persona: input.persona }); }
    catch (error) { logOperationalError("profile completion audit", error); }
  }

  private createFirstOnboardingResponse(profile: UserProfile, schedules: DefaultScheduleProvisionResult): string {
    return (this.deps.onboardingWelcome ?? createOnboardingWelcome)(profile, schedules.schedules);
  }

  private async routeConversationDecisionSafely(input: { purpose: AgentManualPurpose; text: string; profile?: UserProfile; recentTurns: ConversationTurn[] }): Promise<ConversationDecision> {
    if (!this.deps.conversationDecisionRouter) throw new Error("conversationDecisionRouter is required for chat");
    try { return sanitizeConversationDecision(await this.deps.conversationDecisionRouter({ ...input, manual: this.manual }), this.manual, input.purpose); }
    catch (error) {
      logOperationalError("conversation decision router", error);
      return sanitizeConversationDecision({ selectedProcessIds: ["core", "workday_guardrails"], workDecision: { mode: "boundary", reason: "unknown" }, insightDecision: { candidate: false, suggestedKinds: [] } }, this.manual, input.purpose);
    }
  }

  private async getOrCreateOnboardingDraft(employeeId: string): Promise<OnboardingDraft> {
    const existing = await this.stores.onboardingDraftStore.get(employeeId);
    if (existing) return existing;
    const participant = await this.requireParticipant(employeeId);
    const roles = await this.stores.tenantDirectoryStore.listRoles(participant.companyId);
    if (roles.length === 0) throw new Error("participant company has no roles");
    const now = this.clock.now();
    const created: OnboardingDraft = { employeeId, status: "collecting", pendingField: "roleId", revision: 1, createdAt: now, updatedAt: now, expiresAt: onboardingExpiry(now) };
    try { return await this.stores.onboardingDraftStore.save(created, 0); }
    catch (error) {
      if (!(error instanceof PersistenceError) || error.code !== "persistence_conflict") throw error;
      const concurrent = await this.stores.onboardingDraftStore.get(employeeId);
      if (!concurrent) throw error;
      return concurrent;
    }
  }
  private async requireParticipant(employeeId: string) { const participant = await this.stores.profileStore.getParticipant(employeeId); if (!participant) throw new PersistenceError("participant_not_found"); return participant; }
  private validateProfileInput(input: CompleteOnboardingInput) {
    if (input.preferredName !== undefined && !input.preferredName.trim()) throw new Error("preferredName is required");
    if (input.assistantName !== undefined && !input.assistantName.trim()) throw new Error("assistantName is required");
    if (input.timezone !== undefined && normalizeIanaTimezone(input.timezone) === undefined) throw new Error("timezone must be a valid IANA timezone");
    if (!input.roleId?.trim()) throw new Error("roleId is required");
    if (input.selfDescription !== undefined && !input.selfDescription.trim()) throw new Error("selfDescription must be non-empty");
    if (input.typicalTasks !== undefined && normalizePersonalProfileContextPatch({ typicalTasks: input.typicalTasks }).typicalTasks === undefined) throw new Error("typicalTasks must contain at least one non-empty task");
    if (input.programGoal !== undefined && normalizePersonalProfileContextPatch({ programGoal: input.programGoal }).programGoal === undefined) throw new Error("programGoal must be non-empty");
  }
}

function hasCurrentConsent(consent: Consent | undefined): boolean { return consent?.privacyVersion === currentPrivacyVersion; }

const onboardingCorrectionPrompt = "Напишите, что исправить, например: «Зови меня Максим», «На вы, по-человечески» или «Часовой пояс Europe/Moscow».";
const communicationStyleLabels = {
  "informal:support": "на ты, по-человечески",
  "formal:efficiency": "на вы, по-деловому",
  "informal:efficiency": "на ты, коротко и по делу",
  "formal:support": "на вы, по-человечески",
} as const;
const communicationStyleChoices = ["На ты, по-человечески — стиль можно поменять одной фразой", "На вы, по-деловому — стиль можно поменять одной фразой", "На ты, коротко и по делу — стиль можно поменять одной фразой"];
const communicationStyleValues = ["informal_support", "formal_efficiency", "informal_efficiency"];
const timezoneChoices = ["Калининград", "Москва", "Самара", "Екатеринбург", "Омск", "Красноярск", "Иркутск", "Владивосток", "Другой"];
const unrecognizedTimezonePrompt = "Не узнал этот пояс. Выберите ближайший город или напишите город, IANA timezone либо смещение, например UTC+3.";
function onboardingExpiry(now: string): string { const date = new Date(now); date.setDate(date.getDate() + 30); return date.toISOString(); }
function isAffirmativeOnboardingAnswer(text: string): boolean { return /^(?:да|верно|всё верно|подтверждаю|подтвердить)$/iu.test(text.trim()); }
function isNegativeOnboardingAnswer(text: string): boolean { return /^(?:нет|неверно|не верно|исправить|не всё верно)$/iu.test(text.trim()); }
function isCompleteOnboardingDraft(draft: OnboardingDraft): draft is OnboardingDraft & Required<Pick<OnboardingDraft, "roleId" | "preferredName" | "addressForm" | "persona" | "timezone">> {
  return Boolean(draft.roleId && draft.preferredName && draft.addressForm && draft.persona && draft.timezone);
}
function mergePatches(primary: OnboardingProfilePatch, fallback: OnboardingProfilePatch): OnboardingProfilePatch {
  return {
    preferredName: primary.preferredName ?? fallback.preferredName,
    assistantName: primary.assistantName ?? fallback.assistantName,
    addressForm: primary.addressForm ?? fallback.addressForm,
    persona: primary.persona ?? fallback.persona,
    responseLength: primary.responseLength ?? fallback.responseLength,
    timezone: primary.timezone ?? fallback.timezone,
    ambiguousFields: [...new Set([...primary.ambiguousFields, ...fallback.ambiguousFields])],
  };
}
function mergeOnboardingPatch(draft: OnboardingDraft, patch: OnboardingProfilePatch): Pick<OnboardingDraft, "roleId" | "preferredName" | "assistantName" | "addressForm" | "persona" | "responseLength" | "timezone"> {
  const next = { roleId: draft.roleId, preferredName: draft.preferredName, assistantName: draft.assistantName, addressForm: draft.addressForm, persona: draft.persona, responseLength: draft.responseLength, timezone: draft.timezone };
  for (const field of ["preferredName", "assistantName", "addressForm", "persona", "responseLength", "timezone"] as const) {
    const candidate = patch[field];
    if (candidate === undefined || patch.ambiguousFields.includes(field)) continue;
    // A correction is accepted only after the user has seen the full summary.
    // During collection a conflicting candidate never silently overwrites data.
    if (draft.status !== "awaiting_confirmation" && next[field] !== undefined && next[field] !== candidate) continue;
    (next as Record<typeof field, unknown>)[field] = candidate;
  }
  return next;
}
function makeOnboardingDraft(current: OnboardingDraft, values: Pick<OnboardingDraft, "roleId" | "preferredName" | "assistantName" | "addressForm" | "persona" | "responseLength" | "timezone">, now: string): OnboardingDraft {
  const profileFields = ["roleId", "preferredName", "assistantName", "addressForm", "persona", "responseLength", "timezone"] as const;
  const changed = profileFields.some((field) => current[field] !== values[field]);
  const draft: OnboardingDraft = { ...current, ...values, revision: current.revision + (changed ? 1 : 0), updatedAt: now, expiresAt: onboardingExpiry(now) };
  const pendingField = !draft.roleId ? "roleId" : !draft.preferredName ? "preferredName" : !draft.addressForm || !draft.persona ? "communicationStyle" : !draft.timezone ? "timezone" : undefined;
  return pendingField ? { ...draft, status: "collecting", pendingField } : { ...draft, status: "awaiting_confirmation", pendingField: undefined };
}
async function extractOnboardingPatchWithTimeout(
  extractor: OnboardingProfileExtractor,
  input: { text: string; currentDraft: OnboardingDraft },
  timeoutMs: number,
): Promise<OnboardingProfileExtraction> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      extractor({ ...input, signal: controller.signal }),
      new Promise<OnboardingProfileExtraction>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("onboarding_extractor_timeout")); }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function isOnboardingExtractorTimeout(error: unknown): error is Error {
  return error instanceof Error && error.message === "onboarding_extractor_timeout";
}
function onboardingProgress(draft: OnboardingDraft, timezoneUnrecognized = false, roleName?: string): OnboardingProgress {
  if (isCompleteOnboardingDraft(draft)) {
    if (!roleName) throw new Error("role name is required for onboarding confirmation");
    const styleKey = `${draft.addressForm}:${draft.persona}` as keyof typeof communicationStyleLabels;
    return { status: "needs_confirmation", deliveryKey: `${draft.createdAt}:${draft.revision}`, summary: { roleId: draft.roleId, roleName, preferredName: draft.preferredName, communicationStyle: communicationStyleLabels[styleKey], timezone: draft.timezone } };
  }
  const field = !draft.roleId ? "roleId" : !draft.preferredName ? "preferredName" : !draft.addressForm || !draft.persona ? "communicationStyle" : "timezone";
  if (field === "roleId") throw new Error("role selection requires tenant directory context");
  if (field === "communicationStyle") return { status: "needs_choice", field, prompt: "Как удобнее общаться? Стиль можно поменять в любой момент одной фразой.", choices: communicationStyleChoices, choiceValues: communicationStyleValues, allowFreeText: true };
  if (field === "timezone") return { status: "needs_choice", field, prompt: timezoneUnrecognized ? unrecognizedTimezonePrompt : "Выберите ваш часовой пояс. Если нужного города нет, нажмите «Другой» и напишите город или смещение UTC.", choices: timezoneChoices, allowFreeText: true };
  return { status: "needs_answer", field, prompt: "Давайте познакомимся. Как мне к вам обращаться? Стиль общения потом можно поменять одной фразой." };
}
const trackedProfileFields = ["roleId", "preferredName", "assistantName", "addressForm", "persona", "responseLength", "timezone", "role", "typicalTasks", "aiLevel", "programGoal", "preferredCheckinsPerDay"] as const;
function getChangedFields(existing: UserProfile | undefined, next: UserProfile): string[] {
  return trackedProfileFields.filter((field) =>
    // Omitted optional data is not a change on initial creation, while a later
    // removal from an existing profile remains visible in the audit trail.
    (existing !== undefined || next[field] !== undefined)
    && (!existing || JSON.stringify(existing[field]) !== JSON.stringify(next[field])),
  );
}
/** Logs only the operation and error class; user data and driver payloads remain private. */
function logOperationalError(operation: string, error: unknown): void { console.warn(`Minutka ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
function requireDependency<T>(value: T | undefined, name: string): T { if (!value) throw new Error(`${name} is required; production composition has no in-memory fallback`); return value; }
function requireStringDependency(value: string | undefined, name: string): string { const normalized = value?.trim(); if (!normalized) throw new Error(`${name} is required`); return normalized; }
