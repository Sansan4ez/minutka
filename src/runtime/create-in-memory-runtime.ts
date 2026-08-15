import { createInMemoryAuditEventStore } from "../application/in-memory-audit-event-store.js";
import { createInMemoryConversationStore } from "../application/in-memory-conversation-store.js";
import { createInMemoryFeedbackStore } from "../application/in-memory-feedback-store.js";
import { createInMemoryInsightStore } from "../application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../application/in-memory-profile-store.js";
import { createInMemoryTenantDirectoryStore } from "../application/in-memory-tenant-directory-store.js";
import { createInMemoryDocumentStore } from "../application/in-memory-document-store.js";
import { createInMemoryBlobStore } from "../application/in-memory-blob-store.js";
import { createIngestionService } from "../application/ingestion-service.js";
import { createOnboardingContextMaterializer } from "../application/onboarding-context-materializer.js";
import { createInMemoryOnboardingDraftStore } from "../application/in-memory-onboarding-draft-store.js";
import { createInMemoryTelegramInviteRedemptionStore } from "../application/in-memory-telegram-invite-redemption-store.js";
import { createInMemoryTelegramSessionStore, type InMemoryTelegramSessionStore } from "../telegram/in-memory-telegram-session-store.js";
import { createInMemoryPendingActionGroupStore } from "../telegram/in-memory-pending-action-group-store.js";
import type { PendingActionGroupStore } from "../telegram/pending-action-group-store.js";
import { createInMemoryWorld, type InMemoryWorld } from "../application/in-memory-world.js";
import { MinutkaService, type AgentRunner, type MinutkaServiceDeps } from "../application/minutka-service.js";
import { createDeterministicIdGenerator } from "../application/runtime-primitives.js";
import type { ConsentAcceptanceStore } from "../application/consent-acceptance-store.js";
import type { ConversationDecisionRouter } from "../application/conversation-decision-router.js";
import type { InsightExtractor } from "../application/insight-extractor.js";
import type { DocumentStore } from "../application/document-store.js";
import { createPrivacyExplanation } from "../domain/privacy.js";
import { createInMemoryScheduleStore } from "../application/in-memory-schedule-store.js";
import { DefaultScheduleProvisioner } from "../application/default-schedules.js";
import type { ScheduleStore } from "../application/schedule-store.js";

export const executableSpecPrivacyPolicyUrl = "https://privacy.example.test/privacy-v3.html";
export const executableSpecPrivacyExplanation = createPrivacyExplanation(executableSpecPrivacyPolicyUrl);

export type InMemoryRuntime = {
  service: MinutkaService;
  world: InMemoryWorld;
  documentStore: DocumentStore;
  telegramSessionStore: InMemoryTelegramSessionStore;
  pendingActionGroupStore: PendingActionGroupStore;
  scheduleStore: ScheduleStore;
};

/** Executable-spec composition only. Production must use createPostgresRuntime. */
export function createInMemoryRuntime(input: {
  agentRunner: AgentRunner;
  world?: InMemoryWorld;
  deps?: Pick<MinutkaServiceDeps, "auditEventStore" | "contextBuilder" | "agentManualRouter" | "manual" | "onboardingProfileExtractor" | "onboardingContextMaterializer" | "onboardingExtractionTimeoutMs" | "usageRecorder"> & {
    conversationDecisionRouter?: ConversationDecisionRouter;
    insightExtractor?: InsightExtractor;
  };
}): InMemoryRuntime {
  const world = input.world ?? createInMemoryWorld();
  const deps = input.deps ?? {};
  const sessionStore = createInMemoryTelegramSessionStore();
  const clock = { now: () => world.now() };
  const pendingActionGroupStore = createInMemoryPendingActionGroupStore(clock);
  const documentStore = createInMemoryDocumentStore(clock);
  const ingestionService = createIngestionService({
    documentStore,
    blobStore: createInMemoryBlobStore(clock),
  });
  const profileStore = createInMemoryProfileStore(world, {
    afterDelete: async (employeeId) => { await sessionStore.deleteByEmployee(employeeId); world.onboardingDrafts = world.onboardingDrafts.filter((draft) => draft.employeeId !== employeeId); },
  });
  const auditEventStore = createInMemoryAuditEventStore(world);
  const scheduleStore = createInMemoryScheduleStore(clock);
  const consentAcceptanceStore: ConsentAcceptanceStore = {
    async accept({ consent, auditEvent, telegramIdentity }) {
      const result = await profileStore.acceptConsent(consent);
      if (telegramIdentity) {
        await sessionStore.markConsentAccepted({
          identity: telegramIdentity,
          employeeId: consent.employeeId,
          acceptedAt: result.consent.acceptedAt,
        });
      }
      if (result.created) await auditEventStore.append(auditEvent);
      return result;
    },
  };
  const service = new MinutkaService(input.agentRunner, {
    profileStore,
    tenantDirectoryStore: createInMemoryTenantDirectoryStore(world.tenantDirectories),
    onboardingDraftStore: createInMemoryOnboardingDraftStore(world),
    conversationStore: createInMemoryConversationStore(world),
    insightStore: createInMemoryInsightStore(world),
    feedbackStore: createInMemoryFeedbackStore(world),
    auditEventStore: deps.auditEventStore ?? auditEventStore,
    consentAcceptanceStore,
    telegramInviteRedemptionStore: createInMemoryTelegramInviteRedemptionStore({
      profileStore,
      sessionStore,
      auditEventStore,
    }),
    privacyExplanation: executableSpecPrivacyExplanation,
    onboardingContextMaterializer: createOnboardingContextMaterializer({ documentStore, ingestionService }),
    defaultScheduleProvisioner: new DefaultScheduleProvisioner(scheduleStore, clock),
    defaultTenantBinding: { companyId: "default_company", groupId: "default_group", roleId: "default_role" },
    clock,
    idGenerator: createDeterministicIdGenerator(),
    ...deps,
  } as MinutkaServiceDeps);
  return { service, world, documentStore, telegramSessionStore: sessionStore, pendingActionGroupStore, scheduleStore };
}
