import { AssistantService } from "../application/assistant-service.js";
import { contextBudgetConfigFromEnv } from "../application/context-budget.js";
import { PersonalAssistantService, type PersonalAssistantRuntimeInput } from "../application/personal-assistant-service.js";
import { loadAssistantAgentInstructions } from "../application/assistant-manual-loader.js";
import { loadContextPriorityManifest } from "../application/context-priority-manifest.js";
import { assertGeneratedContextSourceMinimums } from "../application/generated-context-startup-validator.js";
import { createIngestionService } from "../application/ingestion-service.js";
import { createOnboardingContextMaterializer } from "../application/onboarding-context-materializer.js";
import { createRuntimeProjectionBuilder } from "../application/runtime-projections/runtime-projection-builder.js";
import { createThreadCompactionService } from "../application/thread-compaction-service.js";
import { TaskMutationConfirmationService } from "../application/task-mutation-confirmation.js";
import { IdeaToTaskService } from "../application/idea-to-task.js";
import { MinutkaService } from "../application/minutka-service.js";
import { randomIdGenerator, systemClock } from "../application/runtime-primitives.js";
import { createPostgresAuditEventStore } from "../infrastructure/postgres/postgres-audit-event-store.js";
import { createPostgresConsentAcceptanceStore } from "../infrastructure/postgres/postgres-consent-acceptance-store.js";
import { createPostgresTelegramInviteRedemptionStore } from "../infrastructure/postgres/postgres-telegram-invite-redemption-store.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresConversationStore } from "../infrastructure/postgres/postgres-conversation-store.js";
import { createPostgresThreadSummaryStore } from "../infrastructure/postgres/postgres-thread-summary-store.js";
import { createPostgresFeedbackStore } from "../infrastructure/postgres/postgres-feedback-store.js";
import { createPostgresInsightStore } from "../infrastructure/postgres/postgres-insight-store.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresProfileStore } from "../infrastructure/postgres/postgres-profile-store.js";
import { createPostgresOnboardingDraftStore } from "../infrastructure/postgres/postgres-onboarding-draft-store.js";
import { createPostgresIdeaStore } from "../infrastructure/postgres/postgres-idea-store.js";
import { createPostgresArtifactStore } from "../infrastructure/postgres/postgres-artifact-store.js";
import { createMinioArtifactContentStore } from "../infrastructure/minio/minio-artifact-content-store.js";
import { createMinioBlobStore } from "../infrastructure/minio/minio-blob-store.js";
import { createMinioClient, minioConfigFromEnv, prepareMinioBucket } from "../infrastructure/minio/minio-config.js";
import { createMinioDocumentStore } from "../infrastructure/minio/minio-document-store.js";
import { createPostgresTelegramSessionStore } from "../infrastructure/postgres/postgres-telegram-session-store.js";
import { createPostgresTaskMutationConfirmationStore } from "../infrastructure/postgres/postgres-task-mutation-confirmation-store.js";
import { createPostgresTaskStore } from "../infrastructure/postgres/postgres-task-store.js";
import { createPostgresScheduleStore } from "../infrastructure/postgres/postgres-schedule-store.js";
import { createPostgresUsageStore } from "../infrastructure/postgres/postgres-usage-store.js";
import { SchedulerService } from "../application/scheduler-service.js";
import { requireTelegramDeliverySession, telegramActionMessageClaimLeaseMilliseconds, telegramActionMessageRetentionMilliseconds } from "../telegram/telegram-session-store.js";
import { extractOnboardingProfileWithAgent } from "../mastra/onboarding-profile-extractor.js";
import { evaluateRequestIntegrity } from "../mastra/request-integrity-guard.js";
import { summarizeThreadWithAgent } from "../mastra/thread-summarizer.js";
import { privacyConfigFromEnv } from "../config/privacy.js";
import { taskMutationCompletedReplayRetentionFromEnv } from "../config/task-confirmation-retention.js";
import { runRetentionCleanupJobs } from "./retention-cleanup.js";
import { productionAssistantTimeoutBudgets } from "../config/assistant-timeout-budgets.js";
import type { createTelegramShell } from "../telegram/telegram-shell.js";
import { usageCostPolicyFromEnv } from "../config/usage.js";
import { createUsageRecorder } from "../application/usage-recorder.js";
import { artifactRuntimeConfigFromEnv } from "../config/artifacts.js";
import { ConversationThreadService } from "../application/conversation-thread-service.js";
import { IdeaDeletionService } from "../application/idea-deletion.js";
import { createPostgresIdeaDeletionConfirmationStore } from "../infrastructure/postgres/postgres-idea-deletion-confirmation-store.js";
import { createSecretBox } from "../infrastructure/postgres/secret-box.js";
import { DefaultScheduleProvisioner } from "../application/default-schedules.js";
import { ScheduleManagementService } from "../application/schedule-management-service.js";
import { ContextDocumentService, contextDocumentConfirmationTtlMilliseconds } from "../application/context-document-service.js";
import { createPostgresContextDocumentConfirmationStore } from "../infrastructure/postgres/postgres-context-document-confirmation-store.js";

export async function createPostgresRuntime(input: PersonalAssistantRuntimeInput & { telegramShell?: Pick<ReturnType<typeof createTelegramShell>, "deliverProactive"> }) {
  // The process manual is deployment configuration: validate it before opening
  // external resources or accepting traffic, then reuse the immutable snapshot.
  const agentInstructions = loadAssistantAgentInstructions();
  const contextPriorities = loadContextPriorityManifest();
  const config = postgresConfigFromEnv(input.env);
  const contextBudget = contextBudgetConfigFromEnv(input.env);
  assertGeneratedContextSourceMinimums(contextBudget, agentInstructions);
  const privacy = privacyConfigFromEnv(input.env);
  const taskMutationCompletedReplayRetentionMilliseconds = taskMutationCompletedReplayRetentionFromEnv(input.env);
  const usageCostPolicy = usageCostPolicyFromEnv(input.env);
  const artifactConfig = artifactRuntimeConfigFromEnv(input.env);
  const pool = createPostgresPool(config);
  try {
    await pool.query("SELECT 1");
    const status = await migrationStatus(pool);
    if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
    const onboardingDraftStore = createPostgresOnboardingDraftStore(pool);
    const telegramSessionStore = createPostgresTelegramSessionStore(
      pool,
      config.telegramIdentityPepper,
      config.integrationEncryptionKey ? createSecretBox(config.integrationEncryptionKey) : undefined,
    );
    const auditEventStore = createPostgresAuditEventStore(pool);
    const taskMutationConfirmationStore = createPostgresTaskMutationConfirmationStore(pool);
    const contextDocumentConfirmationStore = createPostgresContextDocumentConfirmationStore(pool);
    const taskMutations = new TaskMutationConfirmationService(taskMutationConfirmationStore, systemClock, {
      auditEventStore,
      idGenerator: randomIdGenerator,
    });
    if (telegramActionMessageRetentionMilliseconds <= telegramActionMessageClaimLeaseMilliseconds) {
      throw new Error("Telegram action-message retention must exceed the claim lease.");
    }
    const purgeExpiredTelegramActions = () => telegramSessionStore.purgeActionMessages({
      claimedBefore: new Date(Date.now() - telegramActionMessageRetentionMilliseconds).toISOString(),
    });
    const purgeTaskMutationConfirmations = () => taskMutations.purge({
      completedReplayRetentionMilliseconds: taskMutationCompletedReplayRetentionMilliseconds,
    });
    const purgeContextDocumentConfirmations = () => {
      const now = systemClock.now();
      return contextDocumentConfirmationStore.purge({
        pendingExpiredBefore: now,
        completedBefore: new Date(Date.parse(now) - taskMutationCompletedReplayRetentionMilliseconds).toISOString(),
        limit: 500,
      });
    };
    if (taskMutationCompletedReplayRetentionMilliseconds <= contextDocumentConfirmationTtlMilliseconds) {
      throw new Error("Task confirmation replay retention must exceed the context document confirmation TTL.");
    }
    const retentionCleanupJobs = [
      { operation: "Minutka onboarding draft", run: () => onboardingDraftStore.purgeExpired() },
      { operation: "Minutka Telegram action-message", run: purgeExpiredTelegramActions },
      { operation: "Personal assistant task-confirmation", run: purgeTaskMutationConfirmations },
      { operation: "Personal assistant context-document confirmation", run: purgeContextDocumentConfirmations },
    ] as const;
    // Cleanup is best-effort: database connectivity and migrations have already
    // failed fast, while retention housekeeping must not block startup.
    await runRetentionCleanupJobs(retentionCleanupJobs);
    const minioConfig = minioConfigFromEnv(input.env);
    const minioClient = createMinioClient(minioConfig);
    await prepareMinioBucket(minioClient, minioConfig.bucket);
    const documentStore = createMinioDocumentStore({ client: minioClient, bucket: minioConfig.bucket });
    const contextDocuments = new ContextDocumentService(
      documentStore,
      contextDocumentConfirmationStore,
      systemClock,
      { maximumDocumentBytes: contextBudget.documentTools.maximumDocumentBytes, auditEventStore, idGenerator: randomIdGenerator },
    );
    const blobStore = createMinioBlobStore({ client: minioClient, bucket: minioConfig.bucket });
    const artifactContentStore = createMinioArtifactContentStore({ client: minioClient, bucket: minioConfig.bucket });
    const artifactStore = createPostgresArtifactStore({
      pool,
      contentStore: artifactContentStore,
      limits: artifactConfig.saveLimits,
      capacityPolicy: artifactConfig.capacityPolicy,
      onCapacityWarning: (warning) => console.warn("Artifact capacity warning.", warning),
    });
    const ideaStore = createPostgresIdeaStore(pool);
    const ideaDeletions = new IdeaDeletionService(
      ideaStore,
      createPostgresIdeaDeletionConfirmationStore(pool),
      systemClock,
      { auditEventStore, idGenerator: randomIdGenerator },
    );
    const scheduleStore = createPostgresScheduleStore(pool);
    const stores = {
      profileStore: createPostgresProfileStore(pool, config.inviteCodePepper),
      onboardingDraftStore,
      conversationStore: createPostgresConversationStore(pool),
      threadSummaryStore: createPostgresThreadSummaryStore(pool),
      insightStore: createPostgresInsightStore(pool),
      feedbackStore: createPostgresFeedbackStore(pool),
      auditEventStore,
    };
    const ingestion = createIngestionService({
      documentStore,
      blobStore,
      ideaStore,
      maximumContextDocumentBytes: contextBudget.documentTools.maximumDocumentBytes,
    });
    const usageStore = createPostgresUsageStore(pool);
    // Every service that spends provider tokens writes through the same
    // recorder, so the monthly total covers the whole owner contour and each
    // row states which call it came from.
    const usageRecorder = createUsageRecorder({
      usageStore,
      usageCostPolicy,
      auditEventStore,
      clock: systemClock,
      idGenerator: randomIdGenerator,
    });
    // MinutkaService remains a temporary identity/onboarding compatibility
    // component. Product chat never calls its legacy chat path, and onboarding
    // welcome text is deterministic, so production needs no legacy chat agent.
    const identityService = new MinutkaService(async () => "Профиль сохранён. Добро пожаловать!", {
      ...stores,
      consentAcceptanceStore: createPostgresConsentAcceptanceStore(pool, config.telegramIdentityPepper),
      telegramInviteRedemptionStore: createPostgresTelegramInviteRedemptionStore(
        pool,
        config.inviteCodePepper,
        config.telegramIdentityPepper,
      ),
      privacyExplanation: privacy.explanation,
      onboardingContextMaterializer: createOnboardingContextMaterializer({ documentStore, ingestionService: ingestion }),
      defaultScheduleProvisioner: new DefaultScheduleProvisioner(scheduleStore, systemClock),
      clock: systemClock,
      idGenerator: randomIdGenerator,
      onboardingProfileExtractor: extractOnboardingProfileWithAgent,
      usageRecorder,
      ...input.deps,
    });
    const chatProjectionBuilder = createRuntimeProjectionBuilder({ ...stores, clock: systemClock, contextBudget });
    const threadCompactionService = createThreadCompactionService({
      conversationStore: stores.conversationStore,
      summaryStore: stores.threadSummaryStore,
      summarizer: summarizeThreadWithAgent,
      recentTurnLimit: contextBudget.projectionLimits.historyTurns,
      batchTurnLimit: contextBudget.projectionLimits.threadCompactionTurns,
      fieldCharacterLimit: contextBudget.projectionLimits.threadCompactionFieldCharacters,
      summaryCeiling: contextBudget.projectionLimits.threadSummaryCharacters,
      auditEventStore: stores.auditEventStore,
      usageRecorder,
      clock: systemClock,
      idGenerator: randomIdGenerator,
    });
    const taskStore = createPostgresTaskStore(pool);
    const ideaToTask = new IdeaToTaskService(ideaStore, taskStore, taskMutations);
    const scheduleManagement = new ScheduleManagementService(scheduleStore, stores.profileStore, systemClock);
    const assistantChat = new AssistantService(input.assistantAgentRunner, {
      documentStore,
      conversationStore: stores.conversationStore,
      ingestionService: ingestion,
      ideaStore,
      ideaDeletions,
      scheduleManagement,
      taskStore,
      taskMutations,
      ideaToTask,
      auditEventStore: stores.auditEventStore,
      usageStore,
      usageCostPolicy,
      participantStore: stores.profileStore,
      chatProjectionBuilder,
      threadCompactionService,
      requestIntegrityGuard: evaluateRequestIntegrity,
      clock: systemClock,
      idGenerator: randomIdGenerator,
      agentInstructions,
      contextBudget,
      contextPriorities,
      applicationTimeoutMs: productionAssistantTimeoutBudgets.applicationMs,
      recoveryReserveMs: productionAssistantTimeoutBudgets.recoveryReserveMs,
    });
    const conversationThreads = new ConversationThreadService(telegramSessionStore, { clock: systemClock });
    const assistant = new PersonalAssistantService(identityService, assistantChat, artifactStore, taskMutations, conversationThreads, ideaDeletions, scheduleManagement);
    const scheduler = new SchedulerService(scheduleStore, systemClock, async (fire) => {
      if (!input.telegramShell) throw new TelegramDeliveryNotConfiguredError();
      const delivery = requireTelegramDeliverySession(await telegramSessionStore.getDeliveryByEmployee(fire.userId));
      const result = await assistant.runScheduledProcess({
        userId: fire.userId,
        threadId: delivery.threadId,
        processId: fire.processId,
      });
      await input.telegramShell.deliverProactive(delivery.chatId, result, fire.userId);
    });
    // Bounded TTLs permit hourly sweeping; startup cleanup handles restarts.
    const retentionCleanup = setInterval(() => {
      void runRetentionCleanupJobs(retentionCleanupJobs);
    }, 60 * 60 * 1_000);
    retentionCleanup.unref();
    let scheduleTick: ReturnType<typeof setInterval> | undefined;
    const startScheduler = async () => {
      if (scheduleTick) return;
      // The pilot runs one process instance. The durable fire ledger recovers
      // pending work after restart; the interval only materializes due occurrences.
      await scheduler.tick();
      scheduleTick = setInterval(() => {
        void scheduler.tick().catch((error: unknown) => {
          console.warn(`Scheduler tick failed (${error instanceof Error ? error.name : "UnknownError"}).`);
        });
      }, 60_000);
      scheduleTick.unref();
    };
    return {
      assistant,
      ingestion,
      artifactContentStore,
      contextDocuments,
      telegramSessionStore,
      privacyExplanation: privacy.explanation,
      artifactMaximumBytes: artifactConfig.saveLimits.maximumBytes,
      startScheduler,
      /** Safe liveness/readiness probe: exposes no database metadata. */
      health: async () => {
        try { await pool.query("SELECT 1"); return (await migrationStatus(pool)).pending.length === 0; }
        catch { return false; }
      },
      shutdown: async () => { if (scheduleTick) clearInterval(scheduleTick); clearInterval(retentionCleanup); await pool.end(); },
    };
  } catch (error) { await pool.end(); throw error; }
}

class TelegramDeliveryNotConfiguredError extends Error {
  constructor() { super("Telegram delivery is not configured."); this.name = "TelegramDeliveryNotConfiguredError"; }
}
