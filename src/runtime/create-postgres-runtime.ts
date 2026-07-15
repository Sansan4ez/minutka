import { AssistantService, type AssistantAgentRunner } from "../application/assistant-service.js";
import { createIngestionService } from "../application/ingestion-service.js";
import { MinutkaService, type AgentRunner, type MinutkaServiceDeps } from "../application/minutka-service.js";
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
import { createMinioBlobStore } from "../infrastructure/minio/minio-blob-store.js";
import { createMinioClient, minioConfigFromEnv, prepareMinioBucket } from "../infrastructure/minio/minio-config.js";
import { createMinioDocumentStore } from "../infrastructure/minio/minio-document-store.js";
import { createPostgresTelegramSessionStore } from "../infrastructure/postgres/postgres-telegram-session-store.js";
import { createMastraMinutkaServiceDeps } from "../mastra/runtime-deps.js";

export async function createPostgresRuntime(input: { agentRunner: AgentRunner; assistantAgentRunner: AssistantAgentRunner; env: NodeJS.ProcessEnv; deps?: Omit<MinutkaServiceDeps, "profileStore" | "conversationStore" | "insightStore" | "feedbackStore" | "auditEventStore" | "clock" | "idGenerator"> }) {
  const config = postgresConfigFromEnv(input.env);
  const pool = createPostgresPool(config);
  try {
    await pool.query("SELECT 1");
    const status = await migrationStatus(pool);
    if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
    const onboardingDraftStore = createPostgresOnboardingDraftStore(pool);
    // Startup cleanup bounds retention even for employees who never return.
    await onboardingDraftStore.purgeExpired();
    const minioConfig = minioConfigFromEnv(input.env);
    const minioClient = createMinioClient(minioConfig);
    await prepareMinioBucket(minioClient, minioConfig.bucket);
    const documentStore = createMinioDocumentStore({ client: minioClient, bucket: minioConfig.bucket });
    const blobStore = createMinioBlobStore({ client: minioClient, bucket: minioConfig.bucket });
    const ideaStore = createPostgresIdeaStore(pool);
    const stores = {
      profileStore: createPostgresProfileStore(pool, config.inviteCodePepper),
      onboardingDraftStore,
      conversationStore: createPostgresConversationStore(pool),
      insightStore: createPostgresInsightStore(pool),
      feedbackStore: createPostgresFeedbackStore(pool),
      auditEventStore: createPostgresAuditEventStore(pool),
    };
    const service = new MinutkaService(input.agentRunner, {
      ...stores,
      consentAcceptanceStore: createPostgresConsentAcceptanceStore(pool, config.telegramIdentityPepper),
      telegramInviteRedemptionStore: createPostgresTelegramInviteRedemptionStore(
        pool,
        config.inviteCodePepper,
        config.telegramIdentityPepper,
      ),
      clock: systemClock,
      idGenerator: randomIdGenerator,
      ...createMastraMinutkaServiceDeps(),
      ...input.deps,
    });
    const ingestion = createIngestionService({ documentStore, blobStore, ideaStore });
    const assistant = new AssistantService(input.assistantAgentRunner, {
      documentStore,
      conversationStore: stores.conversationStore,
      ingestionService: ingestion,
      ideaStore,
      auditEventStore: stores.auditEventStore,
      clock: systemClock,
      idGenerator: randomIdGenerator,
    });
    // The bounded TTL permits hourly sweeping; startup cleanup handles restarts.
    const draftCleanup = setInterval(() => {
      void onboardingDraftStore.purgeExpired().catch((error: unknown) => {
        console.warn(`Minutka onboarding draft cleanup failed (${error instanceof Error ? error.name : "UnknownError"}).`);
      });
    }, 60 * 60 * 1_000);
    draftCleanup.unref();
    return {
      service,
      assistant,
      ingestion,
      telegramSessionStore: createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper),
      /** Safe liveness/readiness probe: exposes no database metadata. */
      health: async () => {
        try { await pool.query("SELECT 1"); return (await migrationStatus(pool)).pending.length === 0; }
        catch { return false; }
      },
      shutdown: async () => { clearInterval(draftCleanup); await pool.end(); },
    };
  } catch (error) { await pool.end(); throw error; }
}
