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
import { createInMemoryArtifactContentStore } from "../../src/application/in-memory-artifact-content-store.js";
import { createPostgresArtifactStore } from "../../src/infrastructure/postgres/postgres-artifact-store.js";
import { createPostgresIdeaStore } from "../../src/infrastructure/postgres/postgres-idea-store.js";
import { IdeaToTaskService } from "../../src/application/idea-to-task.js";
import { createPostgresTaskStore } from "../../src/infrastructure/postgres/postgres-task-store.js";
import { createPostgresTaskMutationConfirmationStore } from "../../src/infrastructure/postgres/postgres-task-mutation-confirmation-store.js";
import { TaskMutationConfirmationService } from "../../src/application/task-mutation-confirmation.js";

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
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
    expect(await sessions.claim({
      identity: { chatId: "chat_probe", userId: "user_probe" },
      session: { employeeId: "emp_probe", threadId: "thread_probe", createdAt: now, updatedAt: now },
    })).toMatchObject({ status: "claimed" });
    expect(await sessions.getByIdentity({ chatId: "chat_probe" })).toMatchObject({ employeeId: "emp_probe" });
    expect(await sessions.getByIdentity({ chatId: "chat_probe", userId: "wrong_user" })).toBeUndefined();
  });

  it("leases Telegram onboarding confirmation delivery and recovers stale claims", async () => {
    await issueProfileReadyParticipant(pool, "emp_confirmation_claim", "invite_confirmation_claim");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
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
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
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
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
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

  it("gives one result for parallel same-chat claims and identifies the winning constraint", async () => {
    await issueProfileReadyParticipant(pool, "emp_chat_a", "invite_chat_a");
    await issueProfileReadyParticipant(pool, "emp_chat_b", "invite_chat_b");
    const sessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
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
    await ideas.add({ id: "idea_owner_discussed", userId: "idea_owner", project: "АССИСТЕНТ", type: "development", summary: "discussed", status: "discussed" });
    await ideas.add({ id: "idea_owner_planned", userId: "idea_owner", project: "АССИСТЕНТ", type: "development", summary: "planned", status: "planned" });
    await ideas.add({ id: "idea_other", userId: "other_owner", project: "АССИСТЕНТ", type: "development", summary: "private", status: "raw" });
    await pool.query("UPDATE minutka_private.ideas SET last_activity_at = now() - interval '8 days' WHERE idea_id IN ('idea_owner_raw', 'idea_owner_discussed', 'idea_owner_planned', 'idea_other')");

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
    const updated = await ideas.update("idea_owner", "idea_owner_raw", { status: "done" });
    expect(updated).toMatchObject({ status: "done", lastActivityAt: expect.any(String) });
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
    await pool.query("UPDATE minutka_private.task_mutation_confirmations SET completed_at='2026-07-20T00:00:00.000Z' WHERE confirmation_id IN ($1,$2)", [rejected.confirmationId, oldCompleted.confirmationId]);
    await pool.query("UPDATE minutka_private.task_mutation_confirmations SET completed_at='2026-07-27T12:00:00.000Z' WHERE confirmation_id=$1", [recentCompleted.confirmationId]);

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
    await expect(createPostgresIdeaStore(pool).get("idea_task_owner", "idea_task_origin")).resolves.toMatchObject({ status: "raw" });
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
    await expect(tasks.update("task_other", "task-open", { expectedRevision: 2, patch: { status: "done" } })).resolves.toEqual({ outcome: "not_found" });
    await expect(tasks.list("task_owner")).resolves.toHaveLength(3);
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
    });
    const save = (ownerId: string, artifactId: string, deliveryKey: string, fileName: string) => artifacts.save({
      ownerId, artifactId, originalFileName: fileName, declaredMediaType: "text/plain",
      source: { kind: "http_upload", deliveryKey },
      body: { size: 4, openStream: () => Readable.from("same") },
    });
    const first = await save("artifact_owner", "artifact-1", "delivery-1", "first.txt");
    const renamed = await save("artifact_owner", "artifact-2", "delivery-2", "renamed.txt");
    const retry = await save("artifact_owner", "artifact-retry", "delivery-1", "ignored.txt");
    const other = await save("artifact_other", "artifact-1", "delivery-1", "first.txt");
    expect(first.contentDisposition).toBe("stored");
    expect(renamed.contentDisposition).toBe("reused");
    expect(retry).toMatchObject({ deliveryDisposition: "duplicate_delivery", artifact: { artifactId: "artifact-1" } });
    expect(other.contentDisposition).toBe("stored");
    await expect(artifacts.get("artifact_other", "artifact-1")).resolves.toMatchObject({ ownerId: "artifact_other" });
    await expect(artifactContentStore.presignGet("artifact_other", first.artifact.contentDigest, 60)).resolves.toContain("artifact_other");
    await expect(artifactContentStore.presignGet("artifact_owner", first.artifact.contentDigest, 60)).resolves.toContain("artifact_owner");
    await expect(artifacts.delete("artifact_owner", "artifact-1")).resolves.toMatchObject({ status: "deleted" });
    await expect(artifacts.list("artifact_owner")).resolves.toMatchObject([{ artifactId: "artifact-2" }]);
  });

  it("deletes every employee-owned private record", async () => {
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
    const telegramSessions = createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper);
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
    await createPostgresArtifactStore({ pool, contentStore: createInMemoryArtifactContentStore({ now: () => now }), limits: { maximumBytes: 1024, timeoutMs: 1_000 } }).save({
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
    expect((await pool.query("SELECT 1 FROM minutka_audit.events WHERE event_type = 'employee_data_deleted' AND employee_id IS NULL AND metadata = '{}'::jsonb"))).toMatchObject({ rowCount: 1 });
  });
});
