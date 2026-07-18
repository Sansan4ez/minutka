import { AssistantService } from "../application/assistant-service.js";
import { assertContextSourceContentFits, contextBudgetConfigFromEnv } from "../application/context-budget.js";
import { PersonalAssistantService, type PersonalAssistantRuntimeInput } from "../application/personal-assistant-service.js";
import { loadAssistantAgentInstructions } from "../application/assistant-manual-loader.js";
import { loadContextPriorityManifest } from "../application/context-priority-manifest.js";
import { createIngestionService } from "../application/ingestion-service.js";
import { createOnboardingContextMaterializer } from "../application/onboarding-context-materializer.js";
import { createRuntimeProjectionBuilder } from "../application/runtime-projections/runtime-projection-builder.js";
import { MinutkaService } from "../application/minutka-service.js";
import { randomIdGenerator, systemClock } from "../application/runtime-primitives.js";
import { createPostgresAuditEventStore } from "../infrastructure/postgres/postgres-audit-event-store.js";
import { createPostgresConsentAcceptanceStore } from "../infrastructure/postgres/postgres-consent-acceptance-store.js";
import { createPostgresTelegramInviteRedemptionStore } from "../infrastructure/postgres/postgres-telegram-invite-redemption-store.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresConversationStore } from "../infrastructure/postgres/postgres-conversation-store.js";
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
import { telegramActionMessageClaimLeaseMilliseconds, telegramActionMessageRetentionMilliseconds } from "../telegram/telegram-session-store.js";
import { extractOnboardingProfileWithAgent } from "../mastra/onboarding-profile-extractor.js";
import { evaluateRequestIntegrity } from "../mastra/request-integrity-guard.js";
import { privacyConfigFromEnv } from "../config/privacy.js";

export async function createPostgresRuntime(input: PersonalAssistantRuntimeInput) {
  // The process manual is deployment configuration: validate it before opening
  // external resources or accepting traffic, then reuse the immutable snapshot.
  const agentInstructions = loadAssistantAgentInstructions();
  const contextPriorities = loadContextPriorityManifest();
  const config = postgresConfigFromEnv(input.env);
  const contextBudget = contextBudgetConfigFromEnv(input.env);
  assertContextSourceContentFits({
    config: contextBudget,
    sourceId: "agent_manual",
    content: agentInstructions,
    label: "loaded assistant agent manual",
  });
  const privacy = privacyConfigFromEnv(input.env);
  const pool = createPostgresPool(config);
  try {
    await pool.query("SELECT 1");
    const status = await migrationStatus(pool);
    if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
    const onboardingDraftStore = createPostgresOnboardingDraftStore(pool);
    const telegramSessionStore = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
    if (telegramActionMessageRetentionMilliseconds <= telegramActionMessageClaimLeaseMilliseconds) {
      throw new Error("Telegram action-message retention must exceed the claim lease.");
    }
    const purgeExpiredTelegramActions = () => telegramSessionStore.purgeActionMessages({
      claimedBefore: new Date(Date.now() - telegramActionMessageRetentionMilliseconds).toISOString(),
    });
    // Startup cleanup bounds retention even for employees who never return.
    await Promise.all([onboardingDraftStore.purgeExpired(), purgeExpiredTelegramActions()]);
    const minioConfig = minioConfigFromEnv(input.env);
    const minioClient = createMinioClient(minioConfig);
    await prepareMinioBucket(minioClient, minioConfig.bucket);
    const documentStore = createMinioDocumentStore({ client: minioClient, bucket: minioConfig.bucket });
    const blobStore = createMinioBlobStore({ client: minioClient, bucket: minioConfig.bucket });
    const artifactContentStore = createMinioArtifactContentStore({ client: minioClient, bucket: minioConfig.bucket });
    const artifactStore = createPostgresArtifactStore({
      pool,
      contentStore: artifactContentStore,
      limits: { maximumBytes: 100 * 1024 * 1024, timeoutMs: 60_000 },
    });
    const ideaStore = createPostgresIdeaStore(pool);
    const stores = {
      profileStore: createPostgresProfileStore(pool, config.inviteCodePepper),
      onboardingDraftStore,
      conversationStore: createPostgresConversationStore(pool),
      insightStore: createPostgresInsightStore(pool),
      feedbackStore: createPostgresFeedbackStore(pool),
      auditEventStore: createPostgresAuditEventStore(pool),
    };
    const ingestion = createIngestionService({ documentStore, blobStore, ideaStore });
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
      clock: systemClock,
      idGenerator: randomIdGenerator,
      onboardingProfileExtractor: extractOnboardingProfileWithAgent,
      ...input.deps,
    });
    const chatProjectionBuilder = createRuntimeProjectionBuilder({ ...stores, clock: systemClock, contextBudget });
    const assistantChat = new AssistantService(input.assistantAgentRunner, {
      documentStore,
      conversationStore: stores.conversationStore,
      ingestionService: ingestion,
      ideaStore,
      auditEventStore: stores.auditEventStore,
      participantStore: stores.profileStore,
      chatProjectionBuilder,
      requestIntegrityGuard: evaluateRequestIntegrity,
      clock: systemClock,
      idGenerator: randomIdGenerator,
      agentInstructions,
      contextBudget,
      contextPriorities,
    });
    const assistant = new PersonalAssistantService(identityService, assistantChat, artifactStore);
    // Bounded TTLs permit hourly sweeping; startup cleanup handles restarts.
    const retentionCleanup = setInterval(() => {
      void onboardingDraftStore.purgeExpired().catch((error: unknown) => {
        console.warn(`Minutka onboarding draft cleanup failed (${error instanceof Error ? error.name : "UnknownError"}).`);
      });
      void purgeExpiredTelegramActions().catch((error: unknown) => {
        console.warn(`Minutka Telegram action-message cleanup failed (${error instanceof Error ? error.name : "UnknownError"}).`);
      });
    }, 60 * 60 * 1_000);
    retentionCleanup.unref();
    return {
      assistant,
      ingestion,
      artifactContentStore,
      telegramSessionStore,
      privacyExplanation: privacy.explanation,
      /** Safe liveness/readiness probe: exposes no database metadata. */
      health: async () => {
        try { await pool.query("SELECT 1"); return (await migrationStatus(pool)).pending.length === 0; }
        catch { return false; }
      },
      shutdown: async () => { clearInterval(retentionCleanup); await pool.end(); },
    };
  } catch (error) { await pool.end(); throw error; }
}
