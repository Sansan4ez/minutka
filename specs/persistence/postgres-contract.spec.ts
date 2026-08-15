import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../../src/infrastructure/postgres/postgres-pool.js";
import { migratePostgres } from "../../src/infrastructure/postgres/postgres-migrator.js";
import { createPostgresProfileStore } from "../../src/infrastructure/postgres/postgres-profile-store.js";
import { createPostgresConversationStore } from "../../src/infrastructure/postgres/postgres-conversation-store.js";
import { createPostgresThreadSummaryStore } from "../../src/infrastructure/postgres/postgres-thread-summary-store.js";
import { createPostgresFeedbackStore } from "../../src/infrastructure/postgres/postgres-feedback-store.js";
import { createPostgresInsightStore } from "../../src/infrastructure/postgres/postgres-insight-store.js";
import { createPostgresAuditEventStore } from "../../src/infrastructure/postgres/postgres-audit-event-store.js";
import { createPostgresConsentAcceptanceStore } from "../../src/infrastructure/postgres/postgres-consent-acceptance-store.js";
import { createPostgresTelegramInviteRedemptionStore } from "../../src/infrastructure/postgres/postgres-telegram-invite-redemption-store.js";
import { createPostgresTelegramSessionStore } from "../../src/infrastructure/postgres/postgres-telegram-session-store.js";
import { createPostgresOnboardingDraftStore } from "../../src/infrastructure/postgres/postgres-onboarding-draft-store.js";
import { Readable } from "node:stream";
import { ArtifactOwnerQuotaExceededError } from "../../src/application/artifact-capacity.js";
import { createInMemoryArtifactContentStore } from "../../src/application/in-memory-artifact-content-store.js";
import { createPostgresArtifactStore } from "../../src/infrastructure/postgres/postgres-artifact-store.js";
import { createPostgresIdeaStore } from "../../src/infrastructure/postgres/postgres-idea-store.js";
import { IdeaToTaskService } from "../../src/application/idea-to-task.js";
import { ProjectLabelService } from "../../src/application/project-labels.js";
import { createPostgresTaskStore } from "../../src/infrastructure/postgres/postgres-task-store.js";
import { createPostgresScheduleStore } from "../../src/infrastructure/postgres/postgres-schedule-store.js";
import { createPostgresUsageStore } from "../../src/infrastructure/postgres/postgres-usage-store.js";
import type { UsageRecord } from "../../src/application/usage-store.js";
import { createPostgresTaskMutationConfirmationStore } from "../../src/infrastructure/postgres/postgres-task-mutation-confirmation-store.js";
import { TaskMutationConfirmationService } from "../../src/application/task-mutation-confirmation.js";
import { expectInvalidEmptyTaskPatchContract } from "../executable/support/task-store-contract.js";
import { IdeaDeletionService } from "../../src/application/idea-deletion.js";
import { createPostgresIdeaDeletionConfirmationStore } from "../../src/infrastructure/postgres/postgres-idea-deletion-confirmation-store.js";
import { createSecretBox } from "../../src/infrastructure/postgres/secret-box.js";
import { ContextDocumentService } from "../../src/application/context-document-service.js";
import { createInMemoryDocumentStore } from "../../src/application/in-memory-document-store.js";
import { createPostgresContextDocumentConfirmationStore } from "../../src/infrastructure/postgres/postgres-context-document-confirmation-store.js";
import { createPostgresPendingActionGroupStore } from "../../src/infrastructure/postgres/postgres-pending-action-group-store.js";
import { createPostgresActivityCollectionStore } from "../../src/infrastructure/postgres/postgres-activity-collection-store.js";
import { CollectActivityService } from "../../src/application/activity-collection.js";

const url = process.env.TEST_DATABASE_URL;
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (!url || !migrationUrl) {
  throw new Error("TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL are required for specs:persistence");
}

const config = {
  databaseUrl: url,
  ssl: false as const,
  max: 4,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMillis: 5_000,
  inviteCodePepper: "test-invite-pepper",
  telegramIdentityPepper: "test-telegram-pepper",
  integrationEncryptionKey: Buffer.alloc(32, 7),
};
const migrationConfig = { ...config, databaseUrl: migrationUrl };
const now = "2026-07-12T00:00:00.000Z";

function audit(id: string, type: "invite_opened" | "consent_accepted", employeeId?: string) {
  return { id, requestId: `req_${id}`, type, employeeId, occurredAt: now, metadata: {} };
}

async function issueProfileReadyParticipant(pool: ReturnType<typeof createPostgresPool>, employeeId: string, inviteCode: string) {
  const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
  await profiles.issueInvite({ employeeId, inviteCode, issuedAt: now });
  await profiles.openInvite({ inviteCode, openedAt: now, explanationShownAt: now });
  await profiles.acceptConsent({ employeeId, privacyVersion: "privacy-v2", acceptedAt: now, explanationShownAt: now, source: "test" });
  await profiles.completeProfile({
    completedAt: now,
    profile: { employeeId, preferredName: "Manager", assistantName: "Assistant", addressForm: "informal", timezone: "Etc/UTC", role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now },
  });
}

describe("PostgreSQL storage contracts", () => {
  let pool = createPostgresPool(config);
  const migrationPool = createPostgresPool(migrationConfig);

  beforeAll(async () => {
    // Schema ownership stays with the migrator. The runtime role is tested only
    // against an already-migrated database, exactly as it runs in production.
    await migratePostgres(migrationPool);
    await pool.query("DELETE FROM minutka_audit.events; DELETE FROM minutka_private.participants");
  });
  afterAll(async () => {
    await Promise.all([pool.end(), migrationPool.end()]);
  });

  it("dual-writes one private activity and one unlinkable reporting row atomically", async () => {
    const companyId = "company_activity";
    const groupId = "group_activity";
    const roleId = "role_activity";
    await migrationPool.query(
      `INSERT INTO minutka_reference.companies (id, name) VALUES ($1, 'Activity Co')
       ON CONFLICT (id) DO NOTHING`,
      [companyId],
    );
    await migrationPool.query(
      `INSERT INTO minutka_reference.training_groups (id, company_id, name, period)
       VALUES ($1, $2, 'Pilot', daterange('2026-08-01', '2026-09-01', '[)'))
       ON CONFLICT (id) DO NOTHING`,
      [groupId, companyId],
    );
    await migrationPool.query(
      `INSERT INTO minutka_reference.roles (id, company_id, name)
       VALUES ($1, $2, 'Analyst') ON CONFLICT (id) DO NOTHING`,
      [roleId, companyId],
    );
    await issueProfileReadyParticipant(pool, "activity_owner", "invite_activity_owner");
    await migrationPool.query("DELETE FROM minutka_reporting.anonymized_activities WHERE company_id=$1", [companyId]);
    await migrationPool.query("DELETE FROM minutka_private.activities WHERE company_id=$1", [companyId]);

    const service = new CollectActivityService(
      createPostgresActivityCollectionStore(pool),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_pg_one",
    );
    await service.collect({
      employeeId: "activity_owner",
      companyId,
      groupId,
      roleId,
      activity: { taskCategory: "reporting", durationBucket: "1_2h", system: "spreadsheets" },
    });

    expect((await pool.query("SELECT count(*)::int AS count FROM minutka_private.activities WHERE activity_id='activity_pg_one'")).rows[0]?.count).toBe(1);
    const anonymized = await pool.query(
      "SELECT company_id, group_id, role_id, kind, value, duration_bucket, system, activity_date::text FROM minutka_reporting.anonymized_activities WHERE company_id=$1",
      [companyId],
    );
    expect(anonymized.rows).toEqual([{
      company_id: companyId,
      group_id: groupId,
      role_id: roleId,
      kind: "task_category",
      value: "reporting",
      duration_bucket: "1_2h",
      system: "spreadsheets",
      activity_date: "2026-08-15",
    }]);

    const triggerName = "spec_fail_anonymized_activity";
    await migrationPool.query(
      `CREATE OR REPLACE FUNCTION minutka_reporting.spec_fail_anonymized_activity()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced anonymized failure'; END $$;
       DROP TRIGGER IF EXISTS ${triggerName} ON minutka_reporting.anonymized_activities;
       CREATE TRIGGER ${triggerName} BEFORE INSERT ON minutka_reporting.anonymized_activities
       FOR EACH ROW EXECUTE FUNCTION minutka_reporting.spec_fail_anonymized_activity();`,
    );
    try {
      const failingService = new CollectActivityService(
        createPostgresActivityCollectionStore(pool),
        { now: () => "2026-08-16T08:00:00.000Z" },
        () => "activity_pg_rollback",
      );
      await expect(failingService.collect({
        employeeId: "activity_owner",
        companyId,
        groupId,
        roleId,
        activity: { routinePattern: "manual_reporting" },
      })).rejects.toMatchObject({ code: "persistence_unavailable" });
      expect((await pool.query("SELECT count(*)::int AS count FROM minutka_private.activities WHERE activity_id='activity_pg_rollback'")).rows[0]?.count).toBe(0);
    } finally {
      await migrationPool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON minutka_reporting.anonymized_activities`);
      await migrationPool.query("DROP FUNCTION IF EXISTS minutka_reporting.spec_fail_anonymized_activity() CASCADE");
    }
  });

  it("persists metadata-only usage and aggregates it by owner and month", async () => {
    await issueProfileReadyParticipant(pool, "usage_owner", "invite_usage_owner");
    await issueProfileReadyParticipant(pool, "usage_other", "invite_usage_other");
    let usage = createPostgresUsageStore(pool);
    const first: UsageRecord = {
      id: "usage_pg_1", userId: "usage_owner", requestId: "request_usage_pg_1", source: "chat", month: "2026-07",
      inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 40, estimatedCostUsdMicros: 325, occurredAt: "2026-07-31T23:00:00.000Z",
    };
    expect(await usage.record(first)).toMatchObject({ inserted: true });
    await usage.record({
      id: "usage_pg_2", userId: "usage_owner", requestId: "request_usage_pg_2", source: "chat", month: "2026-07",
      inputTokens: 200, outputTokens: 100, totalTokens: 300, estimatedCostUsdMicros: 650, occurredAt: "2026-07-31T23:30:00.000Z",
    });
    // Same request, different source: the auxiliary call must survive the
    // deduplication that previously collapsed it into the chat row.
    await usage.record({
      id: "usage_pg_1_guard", userId: "usage_owner", requestId: "request_usage_pg_1", source: "guard", month: "2026-07",
      inputTokens: 30, outputTokens: 5, totalTokens: 35, cachedInputTokens: 0, estimatedCostUsdMicros: 25, occurredAt: "2026-07-31T23:00:01.000Z",
    });
    await usage.record({
      id: "usage_pg_other", userId: "usage_other", requestId: "request_usage_pg_other", source: "chat", month: "2026-07",
      inputTokens: 20, outputTokens: 10, totalTokens: 30, estimatedCostUsdMicros: 65, occurredAt: "2026-07-31T23:45:00.000Z",
    });
    expect(await usage.record(first)).toMatchObject({ inserted: false });
    expect(await usage.record({
      ...first,
      id: "usage_pg_conflicting_replay",
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1_000,
      cachedInputTokens: 0,
      estimatedCostUsdMicros: 700,
      occurredAt: "2026-07-31T23:10:00.000Z",
    })).toMatchObject({
      inserted: false,
      monthly: { records: 3, inputTokens: 330, outputTokens: 155, totalTokens: 485, estimatedCostUsdMicros: 1000 },
    });

    expect(await usage.getMonthly("usage_owner", "2026-07")).toEqual({
      userId: "usage_owner", month: "2026-07", inputTokens: 330, outputTokens: 155, totalTokens: 485,
      estimatedCostUsdMicros: 1000, records: 3, cachedInputTokens: 40, cachedInputUnknownRecords: 1,
      bySource: [
        {
          source: "chat", inputTokens: 300, outputTokens: 150, totalTokens: 450,
          estimatedCostUsdMicros: 975, records: 2, cachedInputTokens: 40, cachedInputUnknownRecords: 1,
        },
        {
          source: "guard", inputTokens: 30, outputTokens: 5, totalTokens: 35,
          estimatedCostUsdMicros: 25, records: 1, cachedInputTokens: 0, cachedInputUnknownRecords: 0,
        },
      ],
    });
    expect(await usage.getMonthly("usage_other", "2026-07")).toMatchObject({ totalTokens: 30, estimatedCostUsdMicros: 65 });
    expect(await usage.getMonthly("usage_owner", "2026-08")).toMatchObject({ totalTokens: 0, estimatedCostUsdMicros: 0, bySource: [] });
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='minutka_private' AND table_name='usage' ORDER BY ordinal_position",
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "usage_id", "user_id", "request_id", "usage_month", "input_tokens", "output_tokens", "total_tokens",
      "estimated_cost_usd_micros", "occurred_at", "source", "cached_input_tokens",
    ]);
    // An unreported cache breakdown stays NULL: the durable row never claims a
    // cache miss the provider did not report.
    const cached = await pool.query<{ usage_id: string; cached_input_tokens: string | null }>(
      "SELECT usage_id, cached_input_tokens FROM minutka_private.usage WHERE user_id='usage_owner' ORDER BY usage_id",
    );
    expect(cached.rows).toEqual([
      { usage_id: "usage_pg_1", cached_input_tokens: "40" },
      { usage_id: "usage_pg_1_guard", cached_input_tokens: "0" },
      { usage_id: "usage_pg_2", cached_input_tokens: null },
    ]);

    await pool.end();
    pool = createPostgresPool(config);
    usage = createPostgresUsageStore(pool);
    expect(await usage.getMonthly("usage_owner", "2026-07")).toMatchObject({ totalTokens: 485, estimatedCostUsdMicros: 1000 });
  });

  it("persists invite, profile, turn and stable feedback upsert after recreating the pool", async () => {
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    const conversations = createPostgresConversationStore(pool);
    const feedback = createPostgresFeedbackStore(pool);
    await profiles.issueInvite({ employeeId: "emp_pg", inviteCode: "invite_pg", issuedAt: now });
    await profiles.openInvite({ inviteCode: "invite_pg", openedAt: now, explanationShownAt: now });
    await profiles.acceptConsent({ employeeId: "emp_pg", privacyVersion: "privacy-v2", acceptedAt: now, explanationShownAt: now, source: "test" });
    await profiles.completeProfile({ completedAt: now, profile: { employeeId: "emp_pg", preferredName: "Manager", assistantName: "Assistant", addressForm: "informal", timezone: "Etc/UTC", role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now } });
    await conversations.appendTurn({ messageId: "msg_pg", employeeId: "emp_pg", threadId: "thread_pg", userText: "morning", agentResponse: "reply", timestamp: now });
    const first = await feedback.saveFeedback({ id: "fb_original", employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg", rating: "positive", source: "test", updatedAt: now });
    const second = await feedback.saveFeedback({ id: "fb_retry", employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg", rating: "negative", source: "test", updatedAt: "2026-07-12T00:01:00.000Z" });
    expect(second.id).toBe(first.id);

    await pool.end();
    pool = createPostgresPool(config);
    expect((await createPostgresConversationStore(pool).getRecentTurns({ employeeId: "emp_pg", threadId: "thread_pg", limit: 10 }))[0]?.userText).toBe("morning");
    expect((await createPostgresFeedbackStore(pool).getFeedbackByTarget({ employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg" }))?.rating).toBe("negative");
  });

  it("reads the oldest bounded compaction batch in order and persists its watermark", async () => {
    await issueProfileReadyParticipant(pool, "emp_compaction", "invite_compaction");
    const conversations = createPostgresConversationStore(pool);
    for (let index = 1; index <= 15; index++) {
      const suffix = String(index).padStart(2, "0");
      await conversations.appendTurn({
        messageId: `msg_compaction_${suffix}`,
        employeeId: "emp_compaction",
        threadId: "thread_compaction",
        userText: `turn-${suffix}`,
        agentResponse: `reply-${suffix}`,
        timestamp: `2026-07-12T00:00:${suffix}.000Z`,
      });
    }

    const first = await conversations.getTurnsBeforeRecent({
      employeeId: "emp_compaction",
      threadId: "thread_compaction",
      recentLimit: 5,
      limit: 3,
    });
    expect(first.map((turn) => turn.messageId)).toEqual([
      "msg_compaction_01", "msg_compaction_02", "msg_compaction_03",
    ]);

    const summaries = createPostgresThreadSummaryStore(pool);
    const firstCheckpoint = {
      employeeId: "emp_compaction",
      threadId: "thread_compaction",
      text: "## Факты\ncheckpoint\n## Решения\n- нет\n## Договорённости\n- нет\n## Открытые вопросы\n- нет",
      watermark: { fromMessageId: first[0]!.messageId, throughMessageId: first.at(-1)!.messageId },
      updatedAt: now,
    };
    const firstSaveResults = await Promise.all([
      summaries.save(firstCheckpoint),
      summaries.save({ ...firstCheckpoint, text: `${firstCheckpoint.text}\ncompeting` }),
    ]);
    expect(firstSaveResults.sort()).toEqual(["conflict", "saved"]);
    expect((await summaries.get({ employeeId: "emp_compaction", threadId: "thread_compaction" }))?.watermark).toEqual({
      fromMessageId: "msg_compaction_01",
      throughMessageId: "msg_compaction_03",
    });

    await expect(summaries.save({
      ...firstCheckpoint,
      text: `${firstCheckpoint.text}\nadvanced`,
      watermark: { fromMessageId: "msg_compaction_01", throughMessageId: "msg_compaction_04" },
      updatedAt: "2026-07-12T00:01:00.000Z",
    }, "msg_compaction_03")).resolves.toBe("saved");
    await expect(summaries.save({
      ...firstCheckpoint,
      text: `${firstCheckpoint.text}\nstale`,
      watermark: { fromMessageId: "msg_compaction_01", throughMessageId: "msg_compaction_05" },
      updatedAt: "2026-07-12T00:02:00.000Z",
    }, "msg_compaction_03")).resolves.toBe("conflict");
    expect(await summaries.get({ employeeId: "emp_compaction", threadId: "thread_compaction" })).toMatchObject({
      text: `${firstCheckpoint.text}\nadvanced`,
      watermark: { fromMessageId: "msg_compaction_01", throughMessageId: "msg_compaction_04" },
    });
    expect((await conversations.getTurnsBeforeRecent({
      employeeId: "emp_compaction",
      threadId: "thread_compaction",
      recentLimit: 5,
      limit: 3,
      afterMessageId: "msg_compaction_03",
    })).map((turn) => turn.messageId)).toEqual([
      "msg_compaction_04", "msg_compaction_05", "msg_compaction_06",
    ]);
  });

  it("atomically grants exactly one Telegram claim and writes its audit event", async () => {
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    await profiles.issueInvite({ employeeId: "emp_claim", inviteCode: "invite_claim", issuedAt: now });
    const redemption = createPostgresTelegramInviteRedemptionStore(pool, config.inviteCodePepper, config.telegramIdentityPepper);
    const [first, second] = await Promise.all([
      redemption.redeem({ inviteCode: "invite_claim", identity: { chatId: "chat_a", userId: "user_a" }, occurredAt: now, auditEvent: audit("evt_claim_a", "invite_opened") }),
      redemption.redeem({ inviteCode: "invite_claim", identity: { chatId: "chat_b", userId: "user_b" }, occurredAt: now, auditEvent: audit("evt_claim_b", "invite_opened") }),
    ]);
    expect([first.status, second.status].filter((status) => status === "claimed")).toHaveLength(1);
    expect((await pool.query("SELECT employee_id FROM minutka_private.telegram_sessions WHERE employee_id = 'emp_claim'"))).toMatchObject({ rowCount: 1 });
    expect((await pool.query("SELECT event_type FROM minutka_audit.events WHERE employee_id = 'emp_claim' AND event_type = 'invite_opened'"))).toMatchObject({ rowCount: 1 });
  });

  it("resolves a chat-only identity probe even when the session has a user digest", async () => {
    await issueProfileReadyParticipant(pool, "emp_probe", "invite_probe");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    expect(await sessions.claim({
      identity: { chatId: "chat_probe", userId: "user_probe" },
      session: { employeeId: "emp_probe", threadId: "thread_probe", createdAt: now, updatedAt: now },
    })).toMatchObject({ status: "claimed" });
    expect(await sessions.getByIdentity({ chatId: "chat_probe" })).toMatchObject({ employeeId: "emp_probe" });
    expect(await sessions.getByIdentity({ chatId: "chat_probe", userId: "wrong_user" })).toBeUndefined();
    expect(await sessions.getDeliveryByEmployee("emp_probe")).toMatchObject({
      chatId: "chat_probe", employeeId: "emp_probe", threadId: "thread_probe",
    });
    const stored = await pool.query<{ chat_id_ciphertext: Buffer }>(
      "SELECT chat_id_ciphertext FROM minutka_private.telegram_sessions WHERE employee_id = $1",
      ["emp_probe"],
    );
    expect(stored.rows[0]?.chat_id_ciphertext).toBeInstanceOf(Buffer);
    expect(stored.rows[0]?.chat_id_ciphertext.includes(Buffer.from("chat_probe", "utf8"))).toBe(false);
    expect(await sessions.getDeliveryByEmployee("missing")).toBeUndefined();
  });

  it("fails closed for a digest-only Telegram session and restores delivery by relinking", async () => {
    await issueProfileReadyParticipant(pool, "emp_relink", "invite_relink");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    const identity = { chatId: "chat_relink", userId: "user_relink" };
    expect(await sessions.claim({
      identity,
      session: { employeeId: "emp_relink", threadId: "thread_relink", createdAt: now, updatedAt: now },
    })).toMatchObject({ status: "claimed" });
    await pool.query("UPDATE minutka_private.telegram_sessions SET chat_id_ciphertext = NULL WHERE employee_id = $1", ["emp_relink"]);

    expect(await sessions.getByIdentity(identity)).toMatchObject({
      employeeId: "emp_relink",
      deliveryTargetLinked: false,
    });
    expect(await sessions.getDeliveryByEmployee("emp_relink")).toBeUndefined();

    await sessions.linkDeliveryTarget({ identity, employeeId: "emp_relink" });

    expect(await sessions.getByIdentity(identity)).toMatchObject({ deliveryTargetLinked: true });
    expect(await sessions.getDeliveryByEmployee("emp_relink")).toMatchObject({
      chatId: "chat_relink", employeeId: "emp_relink", threadId: "thread_relink",
    });
  });

  it("rotates only the active Telegram thread for an existing owner", async () => {
    await issueProfileReadyParticipant(pool, "emp_rotate", "invite_rotate");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    const identity = { chatId: "chat_rotate", userId: "user_rotate" };
    expect(await sessions.claim({
      identity,
      session: { employeeId: "emp_rotate", threadId: "thread_old", createdAt: now, updatedAt: now },
    })).toMatchObject({ status: "claimed" });
    expect(await sessions.getByIdentity(identity)).not.toHaveProperty("consentAcceptedAt");
    expect(await sessions.getByIdentity(identity)).not.toHaveProperty("consentPrivacyVersion");
    await sessions.markConsentAccepted({ identity, employeeId: "emp_rotate", acceptedAt: now });

    await sessions.rotateThread({ userId: "emp_rotate", nextThreadId: "thread_new", updatedAt: "2026-07-17T11:00:00.000Z" });

    expect(await sessions.getByIdentity(identity)).toMatchObject({
      employeeId: "emp_rotate",
      threadId: "thread_new",
      consentAcceptedAt: now,
      consentPrivacyVersion: "privacy-v2",
      createdAt: now,
      updatedAt: "2026-07-17T11:00:00.000Z",
    });
  });

  it("leases Telegram onboarding confirmation delivery and recovers stale claims", async () => {
    await issueProfileReadyParticipant(pool, "emp_confirmation_claim", "invite_confirmation_claim");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    const identity = { chatId: "chat_confirmation_claim", userId: "user_confirmation_claim" };
    const employeeId = "emp_confirmation_claim";
    expect(await sessions.claim({ identity, session: { employeeId, threadId: "thread_confirmation_claim", createdAt: now, updatedAt: now } })).toMatchObject({ status: "claimed" });

    const firstClaimedAt = "2026-07-17T10:00:00.000Z";
    const [first, second] = await Promise.all([
      sessions.claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-a:7", claimedAt: firstClaimedAt, staleBefore: "2026-07-17T09:59:00.000Z" }),
      sessions.claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-a:7", claimedAt: "2026-07-17T10:00:00.001Z", staleBefore: "2026-07-17T09:59:00.001Z" }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["already_claimed", "claimed"]);

    const recoveredAt = "2026-07-17T10:02:00.000Z";
    await expect(sessions.claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-a:7", claimedAt: recoveredAt, staleBefore: "2026-07-17T10:01:00.000Z" })).resolves.toEqual({ status: "claimed" });
    await sessions.completeOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-a:7", claimedAt: recoveredAt });
    await expect(sessions.claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-a:7", claimedAt: "2026-07-17T10:03:00.000Z", staleBefore: "2026-07-17T10:02:00.000Z" })).resolves.toEqual({ status: "already_claimed" });

    const nextClaimedAt = "2026-07-17T10:04:00.000Z";
    await expect(sessions.claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-b:1", claimedAt: nextClaimedAt, staleBefore: "2026-07-17T10:03:00.000Z" })).resolves.toEqual({ status: "claimed" });
    await sessions.releaseOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-b:1", claimedAt: nextClaimedAt });
    await expect(sessions.claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey: "draft-b:1", claimedAt: "2026-07-17T10:04:01.000Z", staleBefore: "2026-07-17T10:03:01.000Z" })).resolves.toEqual({ status: "claimed" });
  });

  it("leases Telegram action messages, releases failures, and preserves completed idempotency", async () => {
    await issueProfileReadyParticipant(pool, "emp_action_claim", "invite_action_claim");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    const identity = { chatId: "chat_action_claim", userId: "user_action_claim" };
    const employeeId = "emp_action_claim";
    expect(await sessions.claim({ identity, session: { employeeId, threadId: "thread_action_claim", createdAt: now, updatedAt: now } })).toMatchObject({ status: "claimed" });

    const firstClaimedAt = "2026-07-17T10:00:00.000Z";
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 1, claimedAt: firstClaimedAt, staleBefore: "2026-07-17T09:59:00.000Z" })).resolves.toEqual({ status: "claimed" });
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 1, claimedAt: "2026-07-17T10:00:01.000Z", staleBefore: "2026-07-17T09:59:01.000Z" })).resolves.toEqual({ status: "already_claimed" });
    await sessions.releaseActionMessage({ identity, employeeId, messageId: 1, claimedAt: firstClaimedAt });

    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 1, claimedAt: "2026-07-17T10:01:00.000Z", staleBefore: "2026-07-17T10:00:00.000Z" })).resolves.toEqual({ status: "claimed" });
    await sessions.releaseActionMessage({ identity, employeeId, messageId: 1, claimedAt: "2026-07-17T10:01:00.000Z" });

    const retriedAt = "2026-07-17T10:01:01.000Z";
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 1, claimedAt: retriedAt, staleBefore: "2026-07-17T09:59:02.000Z" })).resolves.toEqual({ status: "claimed" });
    await sessions.completeActionMessage({ identity, employeeId, messageId: 1, claimedAt: retriedAt });
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 1, claimedAt: "2026-07-17T10:02:00.000Z", staleBefore: "2026-07-17T10:01:00.000Z" })).resolves.toEqual({ status: "already_claimed" });

    const crashedAt = "2026-07-17T10:03:00.000Z";
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 2, claimedAt: crashedAt, staleBefore: "2026-07-17T10:02:00.000Z" })).resolves.toEqual({ status: "claimed" });
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 2, claimedAt: "2026-07-17T10:05:00.000Z", staleBefore: "2026-07-17T10:04:00.000Z" })).resolves.toEqual({ status: "claimed" });
  });

  it("sweeps only Telegram action messages older than the retention boundary", async () => {
    await issueProfileReadyParticipant(pool, "emp_action_sweep", "invite_action_sweep");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    const identity = { chatId: "chat_action_sweep", userId: "user_action_sweep" };
    const employeeId = "emp_action_sweep";
    expect(await sessions.claim({ identity, session: { employeeId, threadId: "thread_action_sweep", createdAt: now, updatedAt: now } })).toMatchObject({ status: "claimed" });

    const oldClaimedAt = "2026-06-01T00:00:00.000Z";
    const freshClaimedAt = "2026-07-17T10:00:00.000Z";
    await sessions.claimActionMessage({ identity, employeeId, messageId: 10, claimedAt: oldClaimedAt, staleBefore: "2026-05-31T23:59:00.000Z" });
    await sessions.completeActionMessage({ identity, employeeId, messageId: 10, claimedAt: oldClaimedAt });
    await sessions.claimActionMessage({ identity, employeeId, messageId: 11, claimedAt: freshClaimedAt, staleBefore: "2026-07-17T09:59:00.000Z" });
    await sessions.completeActionMessage({ identity, employeeId, messageId: 11, claimedAt: freshClaimedAt });

    await expect(sessions.purgeActionMessages({ claimedBefore: "2026-07-01T00:00:00.000Z" })).resolves.toBe(1);
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 10, claimedAt: "2026-07-18T00:00:00.000Z", staleBefore: "2026-07-17T23:59:00.000Z" })).resolves.toEqual({ status: "claimed" });
    await expect(sessions.claimActionMessage({ identity, employeeId, messageId: 11, claimedAt: "2026-07-18T00:00:00.000Z", staleBefore: "2026-07-17T23:59:00.000Z" })).resolves.toEqual({ status: "already_claimed" });
  });

  it("persists owner-scoped Telegram pending-action groups and partial item state", async () => {
    await issueProfileReadyParticipant(pool, "group_owner_a", "invite_group_owner_a");
    await issueProfileReadyParticipant(pool, "group_owner_b", "invite_group_owner_b");
    const action = (confirmationId: string, title: string) => ({
      confirmationId,
      actionKind: "cancel" as const,
      summary: `Отменить ${title}`,
      expiresAt: "2099-01-01T00:15:00.000Z",
      preview: {
        kind: "cancel" as const,
        taskId: { value: confirmationId, truncated: false },
        taskTitle: { value: title, truncated: false },
      },
    });
    let groups = createPostgresPendingActionGroupStore(pool);
    await groups.create({
      groupId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      ownerId: "group_owner_a",
      items: [
        { ordinal: 1, action: action("confirmation-a-1", "Первое"), state: "pending" },
        { ordinal: 2, action: action("confirmation-a-2", "Второе"), state: "pending" },
      ],
      createdAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:15:00.000Z",
    });
    await expect(groups.getLatestDelivered("group_owner_a")).resolves.toBeUndefined();
    await groups.markDelivered({ ownerId: "group_owner_a", groupId: "aaaaaaaaaaaaaaaaaaaaaaaa", messageId: 42 });
    await groups.markItemsResolved({ ownerId: "group_owner_a", groupId: "aaaaaaaaaaaaaaaaaaaaaaaa", ordinals: [1] });

    groups = createPostgresPendingActionGroupStore(pool);
    await expect(groups.get("group_owner_a", "aaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toMatchObject({
      state: "delivered", messageId: 42, items: [{ ordinal: 1, state: "resolved" }, { ordinal: 2, state: "pending" }],
    });
    await expect(groups.get("group_owner_b", "aaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBeUndefined();
    await expect(groups.markItemsResolved({ ownerId: "group_owner_b", groupId: "aaaaaaaaaaaaaaaaaaaaaaaa", ordinals: [2] })).resolves.toBeUndefined();
    const stored = await pool.query<{ items: unknown }>("SELECT items FROM minutka_private.telegram_pending_action_groups WHERE group_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'");
    const serialized = JSON.stringify(stored.rows[0]?.items);
    expect(serialized).not.toContain("proposal");
    expect(serialized).not.toContain("chatId");
    expect(serialized).not.toContain("body");

    await groups.complete("group_owner_a", "aaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(groups.getLatestDelivered("group_owner_a")).resolves.toBeUndefined();
    await pool.query("UPDATE minutka_private.telegram_pending_action_groups SET expires_at = now() - interval '1 minute', created_at = now() - interval '2 minutes' WHERE group_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'");
    await expect(groups.purgeExpired({ limit: 1 })).resolves.toBe(1);
    await expect(groups.get("group_owner_a", "aaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBeUndefined();
  });

  it("gives one result for parallel same-chat claims and identifies the winning constraint", async () => {
    await issueProfileReadyParticipant(pool, "emp_chat_a", "invite_chat_a");
    await issueProfileReadyParticipant(pool, "emp_chat_b", "invite_chat_b");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    const [first, second] = await Promise.all([
      sessions.claim({ identity: { chatId: "shared_chat", userId: "user_a" }, session: { employeeId: "emp_chat_a", threadId: "thread_a", createdAt: now, updatedAt: now } }),
      sessions.claim({ identity: { chatId: "shared_chat", userId: "user_b" }, session: { employeeId: "emp_chat_b", threadId: "thread_b", createdAt: now, updatedAt: now } }),
    ]);
    expect([first.status, second.status].filter((status) => status === "claimed")).toHaveLength(1);
    expect([first.status, second.status]).toContain("chat_already_linked");
  });

  it("returns idempotent results for parallel issueInvite calls", async () => {
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    const results = await Promise.all([
      profiles.issueInvite({ employeeId: "emp_parallel_issue", inviteCode: "invite_parallel_issue", issuedAt: now }),
      profiles.issueInvite({ employeeId: "emp_parallel_issue", inviteCode: "invite_parallel_issue", issuedAt: now }),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.participant.employeeId === "emp_parallel_issue" && result.inviteMatches)).toBe(true);
  });

  it("commits consent and its audit event together and replaces an obsolete version", async () => {
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    await profiles.issueInvite({ employeeId: "emp_consent", inviteCode: "invite_consent", issuedAt: now });
    await profiles.openInvite({ inviteCode: "invite_consent", openedAt: now, explanationShownAt: now });
    await profiles.acceptConsent({ employeeId: "emp_consent", privacyVersion: "privacy-v1", acceptedAt: "2026-07-01T00:00:00.000Z", explanationShownAt: "2026-07-01T00:00:00.000Z", source: "test" });
    const consent = createPostgresConsentAcceptanceStore(pool);
    const accepted = await consent.accept({
      consent: { employeeId: "emp_consent", privacyVersion: "privacy-v2", acceptedAt: now, explanationShownAt: now, source: "test" },
      auditEvent: { ...audit("evt_consent", "consent_accepted", "emp_consent"), metadata: { privacyVersion: "privacy-v2" } },
    });
    expect(accepted.created).toBe(true);
    expect(accepted.consent.privacyVersion).toBe("privacy-v2");
    expect(await profiles.getConsent("emp_consent")).toMatchObject({ privacyVersion: "privacy-v2", acceptedAt: now });
    expect((await createPostgresAuditEventStore(pool).listCurrent({ requestId: "req_evt_consent", limit: 10 })).map((event) => event.type)).toEqual(["consent_accepted"]);
  });

  it("rejects cross-employee feedback and insight links at the database boundary", async () => {
    await issueProfileReadyParticipant(pool, "emp_owner_a", "invite_owner_a");
    await issueProfileReadyParticipant(pool, "emp_owner_b", "invite_owner_b");
    const conversations = createPostgresConversationStore(pool);
    await conversations.appendTurn({ messageId: "msg_owner_a", employeeId: "emp_owner_a", threadId: "thread_owner_a", userText: "private", agentResponse: "reply", timestamp: now });
    await conversations.appendTurn({ messageId: "msg_owner_b", employeeId: "emp_owner_b", threadId: "thread_owner_b", userText: "private", agentResponse: "reply", timestamp: now });
    await expect(pool.query("INSERT INTO minutka_private.feedback(feedback_id, employee_id, thread_id, target_message_id, rating, source, created_at, updated_at) VALUES ('fb_cross', 'emp_owner_a', 'thread_owner_a', 'msg_owner_b', 'positive', 'test', $1, $1)", [now])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO minutka_private.insights(insight_id, employee_id, thread_id, source_message_id, kind, label, confidence, payload, created_at) VALUES ('ins_cross', 'emp_owner_a', 'thread_owner_a', 'msg_owner_b', 'task_category', 'cross', 'low', '{}', $1)", [now])).rejects.toMatchObject({ code: "23503" });
  });

  it("filters forbidden audit metadata at the store boundary", async () => {
    const auditStore = createPostgresAuditEventStore(pool);
    await auditStore.append({
      id: "evt_safe_metadata",
      requestId: "req_safe_metadata",
      type: "chat_received",
      employeeId: "emp_pg",
      occurredAt: now,
      metadata: { text: "must never persist" } as never,
    });
    expect((await auditStore.listCurrent({ requestId: "req_safe_metadata", limit: 1 }))[0]?.metadata).toEqual({});
  });

  it("returns the newest current audit window in chronological order", async () => {
    const auditStore = createPostgresAuditEventStore(pool);
    for (let index = 0; index < 55; index++) {
      await auditStore.append({
        id: `evt_current_${String(index).padStart(2, "0")}`,
        requestId: "req_current_window",
        type: "chat_received",
        employeeId: "emp_pg",
        occurredAt: now,
        metadata: {},
      });
    }
    const events = await auditStore.listCurrent({ requestId: "req_current_window", limit: 50 });
    expect(events).toHaveLength(50);
    expect(events[0]?.id).toBe("evt_current_05");
    expect(events.at(-1)?.id).toBe("evt_current_54");
  });

  it("purges expired onboarding drafts and never revives one during a stale CAS write", async () => {
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    const drafts = createPostgresOnboardingDraftStore(pool);
    await profiles.issueInvite({ employeeId: "emp_draft", inviteCode: "invite_draft", issuedAt: now });
    const expired = { employeeId: "emp_draft", status: "collecting" as const, pendingField: "preferredName" as const, revision: 1, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-02-01T00:00:00.000Z" };
    await drafts.save(expired, 0);
    const fresh = { ...expired, revision: 2, createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-02-01T00:00:00.000Z" };
    await expect(drafts.save(fresh, expired.revision)).rejects.toMatchObject({ code: "persistence_conflict" });
    expect(await drafts.purgeExpired()).toBe(1);
    expect((await pool.query("SELECT 1 FROM minutka_private.onboarding_drafts WHERE employee_id = 'emp_draft'"))).toMatchObject({ rowCount: 0 });
    expect(await drafts.save({ ...fresh, revision: 1 }, 0)).toMatchObject({ revision: 1, expiresAt: fresh.expiresAt });
    expect(await drafts.replace({ ...fresh, revision: 2, pendingField: "assistantName" })).toMatchObject({ revision: 2, pendingField: "assistantName" });
    await profiles.completeProfile({ completedAt: now, allowUpdate: false, deleteOnboardingDraft: true, profile: { employeeId: "emp_draft", preferredName: "Manager", assistantName: "Assistant", addressForm: "informal", timezone: "Etc/UTC", role: "Manager", typicalTasks: ["reports"], persona: "support", aiLevel: "beginner", responseLength: "balanced", createdAt: now, updatedAt: now } });
    expect((await pool.query("SELECT 1 FROM minutka_private.onboarding_drafts WHERE employee_id = 'emp_draft'"))).toMatchObject({ rowCount: 0 });
    await expect(drafts.save({ ...fresh, revision: 3 }, 0)).rejects.toMatchObject({ code: "persistence_conflict" });
  });

  it("keeps IdeaStore owner-scoped and returns only stale raw or discussed ideas", async () => {
    await issueProfileReadyParticipant(pool, "idea_owner", "invite_idea_owner");
    await issueProfileReadyParticipant(pool, "other_owner", "invite_other_owner");
    const ideas = createPostgresIdeaStore(pool);
    await ideas.add({ id: "idea_owner_raw", userId: "idea_owner", project: "АССИСТЕНТ", type: "development", summary: "raw", source: { kind: "text", text: "raw" }, status: "raw" });
    await ideas.add({ id: "idea_owner_discussed", userId: "idea_owner", project: "АССИСТЕНТ", type: "development", summary: "discussed\n", status: "discussed" });
    await ideas.add({ id: "idea_owner_planned", userId: "idea_owner", project: "АССИСТЕНТ", type: "development", summary: "planned", status: "planned" });
    await ideas.add({ id: "idea_other", userId: "other_owner", project: "Секрет", type: "development", summary: "private", status: "raw" });
    await pool.query("UPDATE minutka_private.ideas SET last_activity_at = now() - interval '8 days' WHERE idea_id IN ('idea_owner_raw', 'idea_owner_discussed', 'idea_owner_planned', 'idea_other')");

    const projects = await new ProjectLabelService(ideas, createPostgresTaskStore(pool)).list("idea_owner");
    expect(projects.projects).toEqual(expect.arrayContaining([expect.objectContaining({ project: "АССИСТЕНТ" })]));
    expect(projects.projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ project: "Секрет" })]));
    await expect(ideas.list("idea_owner", { project: "АССИСТЕНТ", status: "raw" })).resolves.toMatchObject([{ id: "idea_owner_raw", source: { kind: "text", text: "raw" } }]);
    await pool.query("UPDATE minutka_private.ideas SET last_activity_at = now() WHERE idea_id = 'idea_owner_planned'");
    await expect(ideas.list("idea_owner", undefined, { limit: 1, order: "activity_desc" })).resolves.toMatchObject([{ id: "idea_owner_planned" }]);
    await expect(ideas.stale("idea_owner", 7)).resolves.toMatchObject([{ id: "idea_owner_discussed" }, { id: "idea_owner_raw" }]);
    await expect(ideas.list("other_owner")).resolves.toMatchObject([{ id: "idea_other" }]);
    await expect(ideas.add({ id: "idea_owner_raw", userId: "other_owner", project: "БНВ", type: "content", summary: "duplicate", status: "raw" })).rejects.toMatchObject({ code: "persistence_conflict" });
    await expect(ideas.update("other_owner", "idea_owner_raw", { status: "done" })).resolves.toBeNull();
    await expect(ideas.add({ id: "idea_missing_owner", userId: "missing_owner", project: "АССИСТЕНТ", type: "knowledge", summary: "must fail", status: "raw" })).rejects.toMatchObject({ code: "persistence_conflict" });
    await expect(ideas.add({ id: "idea_blank_summary", userId: "idea_owner", project: "АССИСТЕНТ", type: "knowledge", summary: " ", status: "raw" })).rejects.toThrow("summary is required");
    await expect(ideas.update("idea_owner", "idea_owner_raw", { summary: "" })).rejects.toThrow("summary is required");
    await expect(ideas.update("idea_owner", "idea_owner_raw", { source: undefined })).resolves.toMatchObject({ source: { kind: "text", text: "raw" } });
    const beforeAppend = await ideas.get("idea_owner", "idea_owner_raw");
    await expect(ideas.append("other_owner", "idea_owner_raw", { expectedRevision: beforeAppend!.revision, text: "private" })).resolves.toEqual({ status: "not_found" });
    await expect(ideas.append("idea_owner", "idea_owner_raw", { expectedRevision: beforeAppend!.revision + 1, text: "stale" })).resolves.toMatchObject({ status: "conflict", current: { summary: "raw" } });
    await expect(ideas.append("idea_owner", "idea_owner_raw", { expectedRevision: beforeAppend!.revision, text: "added detail" })).resolves.toMatchObject({
      status: "applied", idea: { summary: "raw\n\nadded detail", revision: beforeAppend!.revision + 1, lastActivityAt: expect.any(String) },
    });
    const beforeNewlineAppend = await ideas.get("idea_owner", "idea_owner_discussed");
    await expect(ideas.append("idea_owner", "idea_owner_discussed", { expectedRevision: beforeNewlineAppend!.revision, text: "added after newline" })).resolves.toMatchObject({
      status: "applied", idea: { summary: "discussed\n\nadded after newline", revision: beforeNewlineAppend!.revision + 1 },
    });
    const updated = await ideas.update("idea_owner", "idea_owner_raw", { status: "done" });
    expect(updated).toMatchObject({ status: "done", lastActivityAt: expect.any(String) });
  });

  it("rejects a second request-scoped task proposal before PostgreSQL save and proposal audit", async () => {
    await issueProfileReadyParticipant(pool, "emp_task_proposal_slot", "invite_task_proposal_slot");
    let confirmationSequence = 0;
    let proposalSlotReserved = false;
    const reserveProposalSlot = () => {
      if (proposalSlotReserved) throw new Error("only one task proposal is allowed per assistant turn");
      proposalSlotReserved = true;
    };
    const confirmation = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => "2026-07-28T10:00:00.000Z" },
      {
        confirmationId: () => `task-proposal-slot-pg-${++confirmationSequence}`,
        auditEventStore: createPostgresAuditEventStore(pool),
        idGenerator: { auditEventId: () => `evt_task_proposal_slot_${confirmationSequence}` },
      },
    );
    const audit = { requestId: "req_task_proposal_slot", threadId: "thread_task_proposal_slot", messageId: "msg_task_proposal_slot" };

    const first = await confirmation.propose("emp_task_proposal_slot", {
      kind: "create",
      input: { id: "task-proposal-slot-first", title: "First", project: "ASSISTANT", type: "operations", status: "open" },
    }, { audit, beforePersist: reserveProposalSlot });
    await expect(confirmation.propose("emp_task_proposal_slot", {
      kind: "create",
      input: { id: "task-proposal-slot-second", title: "Second", project: "ASSISTANT", type: "operations", status: "open" },
    }, { audit, beforePersist: reserveProposalSlot })).rejects.toThrow("only one task proposal is allowed per assistant turn");

    await expect(pool.query(
      "SELECT confirmation_id FROM minutka_private.task_mutation_confirmations WHERE user_id=$1 ORDER BY confirmation_id",
      ["emp_task_proposal_slot"],
    )).resolves.toMatchObject({ rows: [{ confirmation_id: first.confirmationId }] });
    await expect(pool.query(
      "SELECT event_type FROM minutka_audit.events WHERE request_id=$1 AND event_type='task_mutation_proposed'",
      [audit.requestId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(confirmation.confirm("emp_task_proposal_slot", "task-proposal-slot-pg-2")).resolves.toEqual({ status: "not_found" });
  });

  it("persists task confirmations and executes parallel callbacks exactly once", async () => {
    await issueProfileReadyParticipant(pool, "emp_task_confirmation", "invite_task_confirmation");
    let currentTime = "2026-07-28T10:00:00.000Z";
    const confirmation = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => currentTime },
      { ttlMilliseconds: 60_000, confirmationId: () => "task-confirmation-pg" },
    );
    const pending = await confirmation.propose("emp_task_confirmation", {
      kind: "create",
      input: { id: "task-confirmed-pg", title: "Confirmed task", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await expect(createPostgresTaskStore(pool).list("emp_task_confirmation")).resolves.toEqual([]);

    await pool.query(
      "UPDATE minutka_private.task_mutation_confirmations SET payload=jsonb_set(payload, '{input,title}', to_jsonb('Tampered task'::text)) WHERE confirmation_id=$1",
      [pending.confirmationId],
    );
    await expect(confirmation.confirm("emp_task_confirmation", pending.confirmationId)).resolves.toEqual({ status: "invalid_payload" });
    await pool.query(
      "UPDATE minutka_private.task_mutation_confirmations SET payload=$2::jsonb WHERE confirmation_id=$1",
      [pending.confirmationId, JSON.stringify(pending.proposal)],
    );

    const restarted = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => currentTime },
    );
    const results = await Promise.all([
      restarted.confirm("emp_task_confirmation", pending.confirmationId),
      restarted.confirm("emp_task_confirmation", pending.confirmationId),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_confirmed", "confirmed"]);
    expect(results[0]).toMatchObject({ outcome: { outcome: "created", task: { id: "task-confirmed-pg", revision: 1 } } });
    expect(results[1]).toMatchObject({ outcome: { outcome: "created", task: { id: "task-confirmed-pg", revision: 1 } } });
    await expect(createPostgresTaskStore(pool).list("emp_task_confirmation")).resolves.toHaveLength(1);

    currentTime = "2026-07-28T10:02:00.000Z";
    const expired = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => "2026-07-28T10:00:00.000Z" },
      { ttlMilliseconds: 60_000, confirmationId: () => "task-confirmation-expired-pg" },
    );
    const expiredPending = await expired.propose("emp_task_confirmation", {
      kind: "cancel", taskId: "task-confirmed-pg", expectedRevision: 1,
    });
    const expiredAfterRestart = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => currentTime },
    );
    await expect(expiredAfterRestart.confirm("emp_task_confirmation", expiredPending.confirmationId)).resolves.toEqual({ status: "expired" });

    const rejectedService = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => "2026-07-28T10:00:00.000Z" },
      { confirmationId: () => "task-confirmation-rejected-pg" },
    );
    const rejected = await rejectedService.propose("emp_task_confirmation", {
      kind: "create",
      input: { id: "task-rejected-pg", title: "Rejected task", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await expect(restarted.reject("emp_task_confirmation", rejected.confirmationId)).resolves.toEqual({ status: "rejected" });
    await pool.end();
    pool = createPostgresPool(config);
    const rejectedAfterRestart = new TaskMutationConfirmationService(createPostgresTaskMutationConfirmationStore(pool), { now: () => currentTime });
    await expect(rejectedAfterRestart.confirm("emp_task_confirmation", rejected.confirmationId)).resolves.toEqual({ status: "already_rejected" });
    await expect(createPostgresTaskStore(pool).get("emp_task_confirmation", "task-rejected-pg")).resolves.toBeNull();
  });

  it("persists optimistic idea conversion undo and walks backward through reversible mutations after restart", async () => {
    await issueProfileReadyParticipant(pool, "task_undo_owner", "invite_task_undo_owner");
    await issueProfileReadyParticipant(pool, "task_undo_other", "invite_task_undo_other");
    let currentTime = "2026-08-04T09:00:00.000Z";
    const ideas = createPostgresIdeaStore(pool);
    const tasks = createPostgresTaskStore(pool);
    const confirmations = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => currentTime },
      { confirmationId: (() => { let sequence = 0; return () => `task-undo-pg-${++sequence}`; })() },
    );

    await ideas.add({ id: "idea-undo-safe", userId: "task_undo_owner", project: "ASSISTANT", type: "development", summary: "Keep newer status", status: "raw" });
    const conversion = await new IdeaToTaskService(ideas, tasks, confirmations).propose("task_undo_owner", "idea-undo-safe");
    if (conversion.status !== "needs_confirmation") throw new Error("expected confirmation");
    await confirmations.autoApply("task_undo_owner", conversion.confirmation.confirmationId);
    await ideas.update("task_undo_owner", "idea-undo-safe", { status: "done" });

    await pool.end();
    pool = createPostgresPool(config);
    const restartedIdeas = createPostgresIdeaStore(pool);
    const restartedTasks = createPostgresTaskStore(pool);
    const restarted = new TaskMutationConfirmationService(createPostgresTaskMutationConfirmationStore(pool), { now: () => currentTime });
    await expect(restarted.undo("task_undo_other")).resolves.toEqual({ status: "not_found" });
    await expect(restarted.undo("task_undo_owner")).resolves.toMatchObject({
      status: "undone", actionKind: "idea_to_task", ideaStatusRestored: false, ideaStatusConflict: true,
    });
    await expect(restartedTasks.getByOriginIdeaId("task_undo_owner", "idea-undo-safe")).resolves.toBeNull();
    await expect(restartedIdeas.get("task_undo_owner", "idea-undo-safe")).resolves.toMatchObject({ status: "done", revision: 3 });

    currentTime = "2026-08-04T09:01:00.000Z";
    const first = await restarted.propose("task_undo_owner", {
      kind: "create", input: { id: "task-undo-first", title: "First", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await restarted.autoApply("task_undo_owner", first.confirmationId);
    currentTime = "2026-08-04T09:02:00.000Z";
    const second = await restarted.propose("task_undo_owner", {
      kind: "create", input: { id: "task-undo-second", title: "Second", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await restarted.autoApply("task_undo_owner", second.confirmationId);

    await expect(restarted.undo("task_undo_owner")).resolves.toMatchObject({ status: "undone", task: { id: "task-undo-second" } });
    await expect(restarted.undo("task_undo_owner")).resolves.toMatchObject({ status: "undone", task: { id: "task-undo-first" } });
    await expect(restarted.undo("task_undo_owner")).resolves.toEqual({ status: "not_found" });
  });

  it("returns expired for the newest reversible mutation instead of skipping to an older one", async () => {
    await issueProfileReadyParticipant(pool, "task_undo_expired_owner", "invite_task_undo_expired_owner");
    let currentTime = "2026-08-04T10:00:00.000Z";
    const confirmations = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => currentTime },
      { undoWindowMilliseconds: 60_000, confirmationId: (() => { let sequence = 0; return () => `task-undo-expired-pg-${++sequence}`; })() },
    );
    const older = await confirmations.propose("task_undo_expired_owner", {
      kind: "create", input: { id: "task-undo-expired-older", title: "Older", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await confirmations.autoApply("task_undo_expired_owner", older.confirmationId);
    currentTime = "2026-08-04T10:00:01.000Z";
    const newest = await confirmations.propose("task_undo_expired_owner", {
      kind: "create", input: { id: "task-undo-expired-newest", title: "Newest", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await confirmations.autoApply("task_undo_expired_owner", newest.confirmationId);
    currentTime = "2026-08-04T10:01:02.000Z";

    await expect(confirmations.undo("task_undo_expired_owner")).resolves.toEqual({ status: "expired" });
    await expect(createPostgresTaskStore(pool).list("task_undo_expired_owner")).resolves.toHaveLength(2);
  });

  it("confirms large context document updates and rejects payload tampering", async () => {
    await issueProfileReadyParticipant(pool, "context_document_owner", "invite_context_document_owner");
    const clock = { now: () => "2026-08-03T10:00:00.000Z" };
    const documents = createInMemoryDocumentStore(clock);
    const service = new ContextDocumentService(
      documents,
      createPostgresContextDocumentConfirmationStore(pool),
      clock,
      {
        maximumDocumentBytes: 512 * 1024,
        confirmationId: (() => {
          let sequence = 0;
          return () => `context-document-pg-${++sequence}`;
        })(),
      },
    );
    const original = await documents.put("context_document_owner", "context/00_inbox/source.md", "old text");
    const replacement = "x".repeat(300 * 1024);
    const proposed = await service.proposeUpdate("context_document_owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement,
    });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");

    await expect(service.confirm("context_document_owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({
      status: "confirmed", outcome: { outcome: "updated" },
    });
    await expect(documents.get("context_document_owner", original.path)).resolves.toMatchObject({ content: replacement });

    const current = await documents.get("context_document_owner", original.path);
    if (!current) throw new Error("expected updated document");
    const tampered = await service.proposeUpdate("context_document_owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: current.version, replacement: "safe replacement",
    });
    if (tampered.status !== "needs_confirmation") throw new Error("expected confirmation");
    await pool.query(
      "UPDATE minutka_private.context_document_confirmations SET payload=jsonb_set(payload, '{content}', to_jsonb('tampered replacement'::text)) WHERE confirmation_id=$1",
      [tampered.confirmation.confirmationId],
    );
    await expect(service.confirm("context_document_owner", tampered.confirmation.confirmationId)).resolves.toEqual({ status: "invalid_payload" });
    await expect(documents.get("context_document_owner", original.path)).resolves.toMatchObject({ content: replacement });
  });

  it("purges task confirmations by pending/completed retention, stays bounded, uses purge indexes and preserves owner cascade", async () => {
    await issueProfileReadyParticipant(pool, "confirmation_retention_owner", "invite_confirmation_retention");
    const store = createPostgresTaskMutationConfirmationStore(pool);
    const service = new TaskMutationConfirmationService(store, { now: () => "2026-07-28T09:00:00.000Z" }, {
      ttlMilliseconds: 60_000,
      confirmationId: (() => {
        let sequence = 0;
        return () => `retention-confirmation-${++sequence}`;
      })(),
    });
    const expired = await service.propose("confirmation_retention_owner", {
      kind: "create", input: { id: "retention-expired", title: "Expired", project: "ASSISTANT", type: "operations", status: "open" },
    });
    const rejected = await service.propose("confirmation_retention_owner", {
      kind: "create", input: { id: "retention-rejected", title: "Rejected", project: "ASSISTANT", type: "operations", status: "open" },
    });
    const oldCompleted = await service.propose("confirmation_retention_owner", {
      kind: "create", input: { id: "retention-old", title: "Old", project: "ASSISTANT", type: "operations", status: "open" },
    });
    const recentCompleted = await service.propose("confirmation_retention_owner", {
      kind: "create", input: { id: "retention-recent", title: "Recent", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await service.reject("confirmation_retention_owner", rejected.confirmationId);
    await service.confirm("confirmation_retention_owner", oldCompleted.confirmationId);
    await service.confirm("confirmation_retention_owner", recentCompleted.confirmationId);
    await pool.query("UPDATE minutka_private.task_mutation_confirmations SET created_at='2026-07-19T00:00:00.000Z', completed_at='2026-07-20T00:00:00.000Z' WHERE confirmation_id IN ($1,$2)", [rejected.confirmationId, oldCompleted.confirmationId]);
    await pool.query("UPDATE minutka_private.task_mutation_confirmations SET created_at='2026-07-27T11:00:00.000Z', completed_at='2026-07-27T12:00:00.000Z' WHERE confirmation_id=$1", [recentCompleted.confirmationId]);

    await expect(store.purge({ pendingExpiredBefore: "2026-07-28T10:00:00.000Z", completedBefore: "2026-07-27T00:00:00.000Z", limit: 2 })).resolves.toBe(2);
    await expect(store.purge({ pendingExpiredBefore: "2026-07-28T10:00:00.000Z", completedBefore: "2026-07-27T00:00:00.000Z", limit: 10 })).resolves.toBe(1);
    expect((await pool.query("SELECT confirmation_id FROM minutka_private.task_mutation_confirmations WHERE confirmation_id = ANY($1::text[]) ORDER BY confirmation_id", [[expired.confirmationId, rejected.confirmationId, oldCompleted.confirmationId, recentCompleted.confirmationId]])).rows).toEqual([
      { confirmation_id: recentCompleted.confirmationId },
    ]);
    const indexes = (await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='minutka_private' AND tablename='task_mutation_confirmations'")).rows.map(({ indexname }) => indexname);
    expect(indexes).toEqual(expect.arrayContaining([
      "task_mutation_confirmations_pending_expiry_idx",
      "task_mutation_confirmations_completed_retention_idx",
    ]));

    const cascade = await service.propose("confirmation_retention_owner", {
      kind: "create", input: { id: "retention-cascade", title: "Cascade", project: "ASSISTANT", type: "operations", status: "open" },
    });
    await createPostgresProfileStore(pool, config.inviteCodePepper).deleteEmployeePersonalData("confirmation_retention_owner");
    expect((await pool.query("SELECT 1 FROM minutka_private.task_mutation_confirmations WHERE confirmation_id=$1", [cascade.confirmationId])).rowCount).toBe(0);
  });

  it("soft-deletes and restores an owner idea across PostgreSQL restarts", async () => {
    await issueProfileReadyParticipant(pool, "idea_delete_owner", "invite_idea_delete_owner");
    await issueProfileReadyParticipant(pool, "idea_delete_other", "invite_idea_delete_other");
    const clock = { now: () => "2026-07-31T09:00:00.000Z" };
    let ideas = createPostgresIdeaStore(pool);
    const captured = await ideas.add({ id: "idea_delete_pg", userId: "idea_delete_owner", project: "ASSISTANT", type: "knowledge", summary: "private deletion content", status: "raw" });
    let service = new IdeaDeletionService(ideas, createPostgresIdeaDeletionConfirmationStore(pool), clock, { confirmationId: () => "idea-delete-pg-confirmation" });
    const proposed = await service.propose("idea_delete_owner", { ideaId: captured.id, expectedRevision: captured.revision });
    expect(proposed.status).toBe("needs_confirmation");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await expect(service.confirm("idea_delete_other", proposed.confirmation.confirmationId)).resolves.toEqual({ status: "not_found" });
    await expect(service.confirm("idea_delete_owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "deleted", idea: { revision: 2 } } });
    await expect(ideas.get("idea_delete_owner", captured.id)).resolves.toBeNull();
    await expect(ideas.list("idea_delete_owner")).resolves.toEqual([]);

    await pool.end();
    pool = createPostgresPool(config);
    ideas = createPostgresIdeaStore(pool);
    service = new IdeaDeletionService(ideas, createPostgresIdeaDeletionConfirmationStore(pool), { now: () => "2026-07-31T09:05:00.000Z" });
    await expect(service.confirm("idea_delete_owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({ status: "already_confirmed", outcome: { outcome: "deleted", idea: { revision: 2 } } });
    await expect(service.undo("idea_delete_owner")).resolves.toMatchObject({ outcome: "restored", idea: { revision: 3 } });
    await expect(ideas.get("idea_delete_owner", captured.id)).resolves.toMatchObject({ summary: "private deletion content", revision: 3 });
  });

  it("converts an idea through durable confirmation and recovers the stable result after restart", async () => {
    await issueProfileReadyParticipant(pool, "idea_task_owner", "invite_idea_task_owner");
    const ideas = createPostgresIdeaStore(pool);
    await ideas.add({ id: "idea_task_origin", userId: "idea_task_owner", project: "АССИСТЕНТ", type: "development", summary: "Собрать план", status: "raw" });
    const clock = { now: () => "2026-07-28T09:00:00.000Z" };
    const confirmations = new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool), clock,
      { confirmationId: () => "idea-task-pg-confirmation" },
    );
    let useCase = new IdeaToTaskService(ideas, createPostgresTaskStore(pool), confirmations);
    const proposed = await useCase.propose("idea_task_owner", "idea_task_origin");
    expect(proposed).toMatchObject({ status: "needs_confirmation", originIdeaId: "idea_task_origin" });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await expect(confirmations.confirm("idea_task_owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({
      status: "confirmed", outcome: { outcome: "created", task: { id: proposed.taskId, originIdeaId: "idea_task_origin" } },
    });

    await pool.end();
    pool = createPostgresPool(config);
    const restartedConfirmations = new TaskMutationConfirmationService(createPostgresTaskMutationConfirmationStore(pool), clock);
    useCase = new IdeaToTaskService(createPostgresIdeaStore(pool), createPostgresTaskStore(pool), restartedConfirmations);
    await expect(restartedConfirmations.confirm("idea_task_owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({
      status: "already_confirmed", outcome: { outcome: "created", task: { id: proposed.taskId, originIdeaId: "idea_task_origin" } },
    });
    await expect(useCase.propose("idea_task_owner", "idea_task_origin")).resolves.toEqual({
      status: "already_converted", taskId: proposed.taskId, originIdeaId: "idea_task_origin",
    });
    await expect(createPostgresIdeaStore(pool).get("idea_task_owner", "idea_task_origin")).resolves.toMatchObject({ status: "planned", revision: 2 });
  });

  it("persists owner-scoped tasks across restarts with filters, optimistic conflicts and idea idempotency", async () => {
    await issueProfileReadyParticipant(pool, "task_owner", "invite_task_owner");
    await issueProfileReadyParticipant(pool, "task_other", "invite_task_other");
    const ideas = createPostgresIdeaStore(pool);
    await ideas.add({ id: "task_origin", userId: "task_owner", project: "АССИСТЕНТ", type: "operations", summary: "origin", status: "raw" });
    await ideas.add({ id: "other_origin", userId: "task_other", project: "БНВ", type: "content", summary: "private", status: "raw" });

    let tasks = createPostgresTaskStore(pool);
    const base = { title: "Подготовить план", project: "АССИСТЕНТ", type: "operations" as const, status: "open" as const };
    await expect(tasks.create("task_owner", { ...base, id: "task-open", dueDate: "2026-07-29", originIdeaId: "task_origin" })).resolves.toMatchObject({
      outcome: "created",
      task: { userId: "task_owner", originIdeaId: "task_origin", revision: 1, dueDate: "2026-07-29" },
    });
    await expect(tasks.create("task_owner", { ...base, id: "task-open", dueDate: "2026-07-29", originIdeaId: "task_origin" })).resolves.toMatchObject({
      outcome: "unchanged",
      task: { id: "task-open", revision: 1 },
    });
    await expect(tasks.create("task_owner", { ...base, id: "task-open", title: "Другой payload", dueDate: "2026-07-29", originIdeaId: "task_origin" })).resolves.toMatchObject({
      outcome: "conflict",
      current: { id: "task-open", title: "Подготовить план" },
    });
    await expect(tasks.create("task_owner", { ...base, id: "task-origin-retry", originIdeaId: "task_origin" })).resolves.toMatchObject({
      outcome: "conflict",
      current: { id: "task-open", originIdeaId: "task_origin" },
    });
    await expect(tasks.create("task_other", { ...base, id: "task-cross-origin", originIdeaId: "task_origin" })).rejects.toMatchObject({ code: "persistence_conflict" });
    await expect(tasks.create("task_other", { ...base, id: "task-open" })).resolves.toEqual({ outcome: "conflict" });
    await expect(tasks.create("task_other", { ...base, id: "task-other", project: "БНВ", type: "content", dueDate: "2026-07-28", originIdeaId: "other_origin" })).resolves.toMatchObject({ outcome: "created" });
    await expect(tasks.create("task_owner", { ...base, id: "task-progress", status: "in_progress", dueDate: "2026-07-30" })).resolves.toMatchObject({ outcome: "created" });
    await expect(tasks.create("task_owner", { ...base, id: "task-done", status: "done", project: "БНВ", type: "content" })).resolves.toMatchObject({ outcome: "created" });

    await pool.end();
    pool = createPostgresPool(config);
    tasks = createPostgresTaskStore(pool);
    await expect(tasks.get("task_owner", "task-open")).resolves.toMatchObject({ id: "task-open", revision: 1 });
    await expect(tasks.get("task_other", "task-open")).resolves.toBeNull();
    await expect(tasks.list("task_owner", {
      project: "АССИСТЕНТ",
      type: "operations",
      status: ["open", "in_progress"],
      dueAfter: "2026-07-29",
      dueBefore: "2026-07-30",
    }, { order: "due_asc" })).resolves.toMatchObject([{ id: "task-open" }, { id: "task-progress" }]);
    await expect(tasks.list("task_other", { status: "open" })).resolves.toMatchObject([{ id: "task-other", userId: "task_other" }]);

    await expect(tasks.update("task_owner", "task-open", { expectedRevision: 1, patch: { status: "in_progress" } })).resolves.toMatchObject({
      outcome: "updated",
      task: { status: "in_progress", revision: 2 },
    });
    await expect(tasks.update("task_owner", "task-open", { expectedRevision: 1, patch: { status: "done" } })).resolves.toMatchObject({
      outcome: "conflict",
      current: { status: "in_progress", revision: 2 },
    });
    await expect(tasks.update("task_owner", "task-open", { expectedRevision: 2, patch: { status: "in_progress" } })).resolves.toMatchObject({
      outcome: "unchanged",
      task: { revision: 2 },
    });
    await expectInvalidEmptyTaskPatchContract(tasks, { ownerId: "task_owner", taskId: "task-open", expectedRevision: 2 });
    await expect(tasks.update("task_owner", "task-open", { expectedRevision: 2, patch: { dueDate: null } })).resolves.toMatchObject({
      outcome: "updated",
      task: { revision: 3 },
    });
    await expect(tasks.get("task_owner", "task-open")).resolves.not.toHaveProperty("dueDate");
    await expect(tasks.update("task_other", "task-open", { expectedRevision: 3, patch: { status: "done" } })).resolves.toEqual({ outcome: "not_found" });
    await expect(tasks.list("task_owner")).resolves.toHaveLength(3);
  });

  it("persists schedules and one idempotent fire across adapter restarts", async () => {
    await issueProfileReadyParticipant(pool, "schedule_owner", "invite_schedule_owner");
    await issueProfileReadyParticipant(pool, "schedule_other", "invite_schedule_other");
    let schedules = createPostgresScheduleStore(pool);
    await expect(schedules.save("schedule_owner", {
      id: "schedule-morning", daysOfWeek: 31, kind: "process", processId: "day_focus", oneShot: true,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-30T06:00:00.000Z",
    })).resolves.toMatchObject({
      userId: "schedule_owner", timezone: "Europe/Moscow", daysOfWeek: 31, kind: "process", oneShot: true,
    });
    await expect(schedules.save("schedule_owner", {
      id: "schedule-reminder", daysOfWeek: 64, kind: "reminder", reminderText: "Позвонить маме", oneShot: false,
      timeOfDay: "10:00", timezone: "Europe/Moscow", enabled: false, nextFireAt: "2026-08-02T07:00:00.000Z",
    })).resolves.toMatchObject({
      daysOfWeek: 64, kind: "reminder", reminderText: "Позвонить маме", oneShot: false,
    });
    await pool.query(
      `INSERT INTO minutka_private.process_schedules
         (schedule_id,user_id,process_id,time_of_day,timezone,enabled,next_fire_at)
       VALUES ('schedule-legacy-defaults','schedule_owner','evening_reflection','19:00','Europe/Moscow',true,$1::timestamptz)`,
      ["2026-07-30T06:00:00.000Z"],
    );
    await expect(schedules.get("schedule_owner", "schedule-legacy-defaults")).resolves.toMatchObject({
      daysOfWeek: 127, kind: "process", processId: "evening_reflection", oneShot: false,
    });

    await expect(schedules.claimDue("2026-07-30T06:00:00.000Z")).resolves.toMatchObject([
      {
        scheduleId: "schedule-legacy-defaults", userId: "schedule_owner", daysOfWeek: 127, kind: "process",
        processId: "evening_reflection", oneShot: false, scheduledFor: "2026-07-30T06:00:00.000Z", status: "pending",
      },
      {
        scheduleId: "schedule-morning", userId: "schedule_owner", daysOfWeek: 31, kind: "process", processId: "day_focus",
        oneShot: true, scheduledFor: "2026-07-30T06:00:00.000Z", status: "pending",
      },
    ]);
    await expect(schedules.claimDue("2026-07-30T06:00:00.000Z")).resolves.toHaveLength(2);
    await expect(schedules.get("schedule_owner", "schedule-morning")).resolves.toMatchObject({ nextFireAt: "2026-07-31T06:00:00.000Z" });
    await expect(schedules.save("schedule_owner", {
      id: "schedule-tuesday", daysOfWeek: 0b0000010, kind: "process", processId: "day_focus", oneShot: false,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-08-01T06:00:00.000Z",
    })).resolves.toMatchObject({ daysOfWeek: 0b0000010 });
    const saturdayFires = await schedules.claimDue("2026-08-01T06:00:00.000Z");
    expect(saturdayFires).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheduleId: "schedule-tuesday", scheduledFor: "2026-08-01T06:00:00.000Z" }),
    ]));
    await expect(schedules.get("schedule_owner", "schedule-tuesday")).resolves.toMatchObject({ nextFireAt: "2026-08-04T06:00:00.000Z" });
    await expect(schedules.list("schedule_owner")).resolves.toMatchObject([
      { id: "schedule-morning", userId: "schedule_owner", daysOfWeek: 31, kind: "process", oneShot: true },
      { id: "schedule-tuesday", userId: "schedule_owner", daysOfWeek: 2, kind: "process", oneShot: false },
      { id: "schedule-reminder", userId: "schedule_owner", daysOfWeek: 64, kind: "reminder", reminderText: "Позвонить маме", oneShot: false },
      { id: "schedule-legacy-defaults", userId: "schedule_owner", daysOfWeek: 127, kind: "process", oneShot: false },
    ]);
    await expect(schedules.get("schedule_other", "schedule-morning")).resolves.toBeNull();
    await expect(schedules.list("schedule_other")).resolves.toEqual([]);

    await pool.end();
    pool = createPostgresPool(config);
    schedules = createPostgresScheduleStore(pool);
    await expect(schedules.claimDue("2026-07-30T06:00:00.000Z")).resolves.toHaveLength(saturdayFires.length);
    await expect(schedules.listFires("schedule_owner", "schedule-morning")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({
      daysOfWeek: 31, kind: "process", processId: "day_focus", oneShot: true,
    })]));
    await expect(schedules.get("schedule_owner", "schedule-reminder")).resolves.toMatchObject({
      daysOfWeek: 64, kind: "reminder", reminderText: "Позвонить маме", oneShot: false,
    });
    await expect(schedules.listFires("schedule_other")).resolves.toEqual([]);
    await expect(schedules.completeFire("schedule_owner", {
      scheduleId: "schedule-morning", scheduledFor: "2026-07-30T06:00:00.000Z", status: "succeeded",
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(schedules.completeFire("schedule_owner", {
      scheduleId: "schedule-legacy-defaults", scheduledFor: "2026-07-30T06:00:00.000Z", status: "succeeded",
    })).resolves.toMatchObject({ status: "succeeded" });
    for (const fire of saturdayFires.filter((candidate) => candidate.scheduledFor !== "2026-07-30T06:00:00.000Z")) {
      await expect(schedules.completeFire(fire.userId, {
        scheduleId: fire.scheduleId, scheduledFor: fire.scheduledFor, status: "succeeded",
      })).resolves.toMatchObject({ status: "succeeded" });
    }
    await expect(schedules.claimDue("2026-07-30T06:00:00.000Z")).resolves.toEqual([]);
  });

  it("keeps task schema ownership with the migrator and grants runtime data access only", async () => {
    const privileges = await pool.query<{
      schema_owner: string;
      table_owner: string;
      runtime_can_create: boolean;
      runtime_can_select: boolean;
      runtime_can_insert: boolean;
      runtime_can_update: boolean;
      runtime_can_delete: boolean;
    }>(
      `SELECT
         schema_owner.rolname AS schema_owner,
         table_owner.rolname AS table_owner,
         has_schema_privilege('minutka_runtime', 'minutka_private', 'CREATE') AS runtime_can_create,
         has_table_privilege('minutka_runtime', 'minutka_private.tasks', 'SELECT') AS runtime_can_select,
         has_table_privilege('minutka_runtime', 'minutka_private.tasks', 'INSERT') AS runtime_can_insert,
         has_table_privilege('minutka_runtime', 'minutka_private.tasks', 'UPDATE') AS runtime_can_update,
         has_table_privilege('minutka_runtime', 'minutka_private.tasks', 'DELETE') AS runtime_can_delete
       FROM pg_namespace AS namespace
       JOIN pg_roles AS schema_owner ON schema_owner.oid = namespace.nspowner
       JOIN pg_class AS relation ON relation.relnamespace = namespace.oid AND relation.relname = 'tasks'
       JOIN pg_roles AS table_owner ON table_owner.oid = relation.relowner
       WHERE namespace.nspname = 'minutka_private'`,
    );
    expect(privileges.rows[0]).toEqual({
      schema_owner: "minutka_migrator",
      table_owner: "minutka_migrator",
      runtime_can_create: false,
      runtime_can_select: true,
      runtime_can_insert: true,
      runtime_can_update: true,
      runtime_can_delete: true,
    });
  });

  it("persists owner-scoped artifact references with delivery and content dedup", async () => {
    await issueProfileReadyParticipant(pool, "artifact_owner", "invite_artifact_owner");
    await issueProfileReadyParticipant(pool, "artifact_other", "invite_artifact_other");
    const artifactContentStore = createInMemoryArtifactContentStore({ now: () => now });
    const artifacts = createPostgresArtifactStore({
      pool,
      contentStore: artifactContentStore,
      limits: { maximumBytes: 1024, timeoutMs: 1_000 },
      capacityPolicy: { ownerSoftQuotaBytes: 5, ownerHardQuotaBytes: 10, globalHardQuotaBytes: 20 },
    });
    const save = (ownerId: string, artifactId: string, deliveryKey: string, fileName: string, bytes = "same") => artifacts.save({
      ownerId, artifactId, originalFileName: fileName, declaredMediaType: "text/plain",
      source: { kind: "http_upload", deliveryKey },
      body: { size: Buffer.byteLength(bytes), openStream: () => Readable.from(bytes) },
    });
    const first = await save("artifact_owner", "artifact-1", "delivery-1", "first.txt");
    const renamed = await save("artifact_owner", "artifact-2", "delivery-2", "renamed.txt");
    const retry = await save("artifact_owner", "artifact-retry", "delivery-1", "ignored.txt");
    const other = await save("artifact_other", "artifact-1", "delivery-1", "first.txt");
    expect(first.contentDisposition).toBe("stored");
    expect(renamed.contentDisposition).toBe("reused");
    expect(retry).toMatchObject({ deliveryDisposition: "duplicate_delivery", artifact: { artifactId: "artifact-1" } });
    expect(other.contentDisposition).toBe("stored");
    await expect(artifacts.checkCapacity({ ownerId: "artifact_owner", deliveryKey: "delivery-1", size: 100 })).resolves.toMatchObject({ duplicateDelivery: true, prospectiveBytes: 0 });
    await save("artifact_owner", "artifact-boundary", "delivery-boundary", "boundary.txt", "123456");
    await expect(artifacts.checkCapacity({ ownerId: "artifact_owner", deliveryKey: "delivery-blocked", size: 1 })).rejects.toBeInstanceOf(ArtifactOwnerQuotaExceededError);
    await expect(artifacts.checkCapacity({ ownerId: "artifact_other", deliveryKey: "other-boundary", size: 6 })).resolves.toMatchObject({ ownerUsageBytes: 4 });
    await expect(artifacts.get("artifact_other", "artifact-1")).resolves.toMatchObject({ ownerId: "artifact_other" });
    await expect(artifactContentStore.presignGet("artifact_other", first.artifact.contentDigest, 60)).resolves.toContain("artifact_other");
    await expect(artifactContentStore.presignGet("artifact_owner", first.artifact.contentDigest, 60)).resolves.toContain("artifact_owner");
    await expect(artifacts.delete("artifact_owner", "artifact-1")).resolves.toMatchObject({ status: "deleted" });
    await expect(artifacts.list("artifact_owner")).resolves.toMatchObject([{ artifactId: "artifact-2" }, { artifactId: "artifact-boundary" }]);
  });

  it("deletes every employee-owned private record", async () => {
    const deletionAuditCountBefore = Number((await pool.query<{ count: string }>("SELECT count(*) FROM minutka_audit.events WHERE event_type = 'employee_data_deleted' AND employee_id IS NULL AND metadata = '{}'::jsonb")).rows[0]!.count);
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    const drafts = createPostgresOnboardingDraftStore(pool);
    await profiles.issueInvite({ employeeId: "emp_delete", inviteCode: "invite_delete", issuedAt: now });
    await profiles.openInvite({ inviteCode: "invite_delete", openedAt: now, explanationShownAt: now });
    await profiles.acceptConsent({ employeeId: "emp_delete", privacyVersion: "privacy-v2", acceptedAt: now, explanationShownAt: now, source: "test" });
    // Drafts are intentionally rejected after profile completion. Persist this
    // temporary private record while onboarding is still in progress, then
    // complete the profile without its normal draft-cleanup option.
    await drafts.save({ employeeId: "emp_delete", status: "collecting", pendingField: "preferredName", revision: 1, createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-02-01T00:00:00.000Z" }, 0);
    await profiles.completeProfile({
      completedAt: now,
      profile: { employeeId: "emp_delete", preferredName: "Manager", assistantName: "Assistant", addressForm: "informal", timezone: "Etc/UTC", role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now },
    });
    const conversations = createPostgresConversationStore(pool);
    await conversations.appendTurn({ messageId: "msg_delete", employeeId: "emp_delete", threadId: "thread_delete", userText: "private", agentResponse: "reply", timestamp: now });
    await createPostgresFeedbackStore(pool).saveFeedback({ id: "fb_delete", employeeId: "emp_delete", threadId: "thread_delete", targetMessageId: "msg_delete", rating: "positive", source: "test", updatedAt: now });
    await createPostgresInsightStore(pool).saveInsights([{
      id: "ins_delete", employeeId: "emp_delete", threadId: "thread_delete", sourceMessageId: "msg_delete",
      kind: "task_category", label: "reporting", confidence: "low", category: "reporting", createdAt: now,
    }]);
    const telegramSessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper, createSecretBox(config.integrationEncryptionKey));
    await telegramSessions.claim({
      identity: { chatId: "chat_delete", userId: "user_delete" },
      session: { employeeId: "emp_delete", threadId: "thread_delete", createdAt: now, updatedAt: now },
    });
    await telegramSessions.claimActionMessage({ identity: { chatId: "chat_delete", userId: "user_delete" }, employeeId: "emp_delete", messageId: 1, claimedAt: now, staleBefore: "2026-07-11T23:59:00.000Z" });
    await createPostgresIdeaStore(pool).add({ id: "idea_delete", userId: "emp_delete", project: "АССИСТЕНТ", type: "knowledge", summary: "private idea", status: "raw" });
    await createPostgresTaskStore(pool).create("emp_delete", { id: "task_delete", title: "private task", project: "АССИСТЕНТ", type: "knowledge", status: "open", originIdeaId: "idea_delete" });
    await new TaskMutationConfirmationService(
      createPostgresTaskMutationConfirmationStore(pool),
      { now: () => now },
      { confirmationId: () => "task_confirmation_delete" },
    ).propose("emp_delete", { kind: "cancel", taskId: "task_delete", expectedRevision: 1 });
    await createPostgresArtifactStore({
      pool,
      contentStore: createInMemoryArtifactContentStore({ now: () => now }),
      limits: { maximumBytes: 1024, timeoutMs: 1_000 },
      capacityPolicy: { ownerSoftQuotaBytes: 2048, ownerHardQuotaBytes: 4096, globalHardQuotaBytes: 8192 },
    }).save({
      ownerId: "emp_delete", artifactId: "artifact_delete", originalFileName: "private.txt",
      source: { kind: "http_upload", deliveryKey: "delete-delivery" },
      body: { size: 7, openStream: () => Readable.from("private") },
    });
    await createPostgresAuditEventStore(pool).append({ id: "evt_delete", requestId: "req_delete", type: "chat_received", employeeId: "emp_delete", occurredAt: now, metadata: {} });
    await profiles.deleteEmployeePersonalData("emp_delete");
    for (const table of ["participants", "profiles", "consents", "threads", "messages", "feedback", "insights", "telegram_sessions", "telegram_action_messages", "onboarding_drafts"]) {
      const result = await pool.query(`SELECT 1 FROM minutka_private.${table} WHERE employee_id = 'emp_delete'`);
      expect(result.rowCount).toBe(0);
    }
    expect((await pool.query("SELECT 1 FROM minutka_private.ideas WHERE user_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    expect((await pool.query("SELECT 1 FROM minutka_private.tasks WHERE user_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    expect((await pool.query("SELECT 1 FROM minutka_private.task_mutation_confirmations WHERE user_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    expect((await pool.query("SELECT 1 FROM minutka_private.artifacts WHERE user_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    expect((await pool.query("SELECT 1 FROM minutka_private.artifact_contents WHERE user_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    expect((await pool.query("SELECT 1 FROM minutka_audit.events WHERE employee_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    const deletionAuditCountAfter = Number((await pool.query<{ count: string }>("SELECT count(*) FROM minutka_audit.events WHERE event_type = 'employee_data_deleted' AND employee_id IS NULL AND metadata = '{}'::jsonb")).rows[0]!.count);
    expect(deletionAuditCountAfter).toBe(deletionAuditCountBefore + 1);
  });
});
