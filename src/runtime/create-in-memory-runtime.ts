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
import { createPrivacyExplanation } from "../application/consent-process-loader.js";
import { createInMemoryScheduleStore } from "../application/in-memory-schedule-store.js";
import { DefaultScheduleProvisioner } from "../application/default-schedules.js";
import type { ScheduleStore } from "../application/schedule-store.js";

import { ActivityTransactionService } from "../application/activity-transaction-service.js";
import type { ActivityTransactionExtractor } from "../application/activity-transaction-extractor.js";
import { CollectActivityService } from "../application/activity-collection.js";
import { ActivityCorrectionService } from "../application/activity-correction.js";
import { RecentOwnActivitiesService } from "../application/recent-own-activities.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore, createInMemoryActivityMutationStore, createInMemoryRecentOwnActivityReadStore } from "../application/in-memory-activity-collection-store.js";
import { createInMemoryLinkedActivityTransactionStore } from "../application/linked-activity-transaction-store.js";
import { AssistantService, type AssistantAgentRunner } from "../application/assistant-service.js";
import { createWorkRetrospectiveService } from "../application/work-retrospective-service.js";
import { createInMemoryWorkRetrospectiveStore } from "../application/in-memory-work-retrospective-store.js";
import { createDirectoryWorkRetrospectivePolicyStore, type WorkRetrospectivePolicyStore } from "../application/work-retrospective-policy.js";

export const executableSpecPrivacyPolicyUrl = "https://privacy.example.test/privacy-v6.html";
const executableSpecPrivacyNotice = createPrivacyExplanation(executableSpecPrivacyPolicyUrl);
export const executableSpecPrivacyExplanation = executableSpecPrivacyNotice.short;
export const executableSpecFullPrivacyExplanation = executableSpecPrivacyNotice.full;

export type InMemoryRuntime = {
  service: MinutkaService;
  assistantChat?: AssistantService;
  world: InMemoryWorld;
  documentStore: DocumentStore;
  telegramSessionStore: InMemoryTelegramSessionStore;
  pendingActionGroupStore: PendingActionGroupStore;
  scheduleStore: ScheduleStore;
};

/** Executable-spec composition only. Production must use createPostgresRuntime. */
export function createInMemoryRuntime(input: {
  agentRunner: AgentRunner;
  assistantAgentRunner?: AssistantAgentRunner;
  activityExtractor?: ActivityTransactionExtractor;
  assistantDeps?: Partial<ConstructorParameters<typeof AssistantService>[1]>;
  workRetrospectivePolicies?: WorkRetrospectivePolicyStore;
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
    afterDelete: async (employeeId) => {
      const onboardingDrafts = world.onboardingDrafts.filter((draft) => draft.employeeId === employeeId).length;
      await sessionStore.deleteByEmployee(employeeId);
      world.onboardingDrafts = world.onboardingDrafts.filter((draft) => draft.employeeId !== employeeId);
      return { onboardingDrafts };
    },
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
    clock,
    idGenerator: {
      ...createDeterministicIdGenerator(),
      // Several transports can share one spec world; canonical message IDs must too.
      messageId: () => `msg_${++world.counters.message}`,
    },
    ...deps,
  } as MinutkaServiceDeps);
  const conversationStore = createInMemoryConversationStore(world);
  const retrospective = createWorkRetrospectiveService(createInMemoryWorkRetrospectiveStore(conversationStore), conversationStore);
  const activities = createInMemoryActivityCollectionState();
  const activityTransaction = input.activityExtractor ? new ActivityTransactionService({
    extractor: input.activityExtractor, retrospective, linkedTransactions: createInMemoryLinkedActivityTransactionStore(), clock,
    collection: new CollectActivityService(createInMemoryActivityCollectionStore(activities), clock),
    corrections: new ActivityCorrectionService(createInMemoryActivityMutationStore(activities), clock),
    recentActivities: new RecentOwnActivitiesService(createInMemoryRecentOwnActivityReadStore(activities), clock),
  }) : undefined;
  const assistantChat = input.assistantAgentRunner ? new AssistantService(input.assistantAgentRunner, {
    documentStore, conversationStore, ingestionService, participantStore: profileStore,
    requestIntegrityGuard: async () => ({ status: "allowed" }), clock,
    ...(activityTransaction ? { processCurrentActivityTurn: (command: Parameters<ActivityTransactionService["process"]>[0]) => activityTransaction.process(command) } : {}),
    ...input.assistantDeps,
    workRetrospective: { service: retrospective, policies: input.workRetrospectivePolicies ?? createDirectoryWorkRetrospectivePolicyStore({ profiles: profileStore, directory: createInMemoryTenantDirectoryStore(world.tenantDirectories) }) },
  }) : undefined;
  return { service, assistantChat, world, documentStore, telegramSessionStore: sessionStore, pendingActionGroupStore, scheduleStore };
}
