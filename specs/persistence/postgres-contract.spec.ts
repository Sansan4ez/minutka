import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../../src/infrastructure/postgres/postgres-pool.js";
import { migratePostgres } from "../../src/infrastructure/postgres/postgres-migrator.js";
import { createPostgresProfileStore } from "../../src/infrastructure/postgres/postgres-profile-store.js";
import { createPostgresConversationStore } from "../../src/infrastructure/postgres/postgres-conversation-store.js";
import { createPostgresFeedbackStore } from "../../src/infrastructure/postgres/postgres-feedback-store.js";
import { createPostgresInsightStore } from "../../src/infrastructure/postgres/postgres-insight-store.js";
import { createPostgresAuditEventStore } from "../../src/infrastructure/postgres/postgres-audit-event-store.js";
import { createPostgresConsentAcceptanceStore } from "../../src/infrastructure/postgres/postgres-consent-acceptance-store.js";
import { createPostgresTelegramInviteRedemptionStore } from "../../src/infrastructure/postgres/postgres-telegram-invite-redemption-store.js";
import { createPostgresTelegramSessionStore } from "../../src/infrastructure/postgres/postgres-telegram-session-store.js";

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
  await profiles.acceptConsent({ employeeId, privacyVersion: "privacy-v1", acceptedAt: now, explanationShownAt: now, source: "test" });
  await profiles.completeProfile({
    completedAt: now,
    profile: { employeeId, role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now },
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
    await profiles.acceptConsent({ employeeId: "emp_pg", privacyVersion: "privacy-v1", acceptedAt: now, explanationShownAt: now, source: "test" });
    await profiles.completeProfile({ completedAt: now, profile: { employeeId: "emp_pg", role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now } });
    await conversations.appendTurn({ messageId: "msg_pg", employeeId: "emp_pg", threadId: "thread_pg", userText: "morning", agentResponse: "reply", timestamp: now });
    const first = await feedback.saveFeedback({ id: "fb_original", employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg", rating: "positive", source: "test", updatedAt: now });
    const second = await feedback.saveFeedback({ id: "fb_retry", employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg", rating: "negative", source: "test", updatedAt: "2026-07-12T00:01:00.000Z" });
    expect(second.id).toBe(first.id);

    await pool.end();
    pool = createPostgresPool(config);
    expect((await createPostgresConversationStore(pool).getRecentTurns({ employeeId: "emp_pg", threadId: "thread_pg", limit: 10 }))[0]?.userText).toBe("morning");
    expect((await createPostgresFeedbackStore(pool).getFeedbackByTarget({ employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg" }))?.rating).toBe("negative");
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

  it("commits consent and its audit event together", async () => {
    const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
    await profiles.issueInvite({ employeeId: "emp_consent", inviteCode: "invite_consent", issuedAt: now });
    await profiles.openInvite({ inviteCode: "invite_consent", openedAt: now, explanationShownAt: now });
    const consent = createPostgresConsentAcceptanceStore(pool);
    const accepted = await consent.accept({
      consent: { employeeId: "emp_consent", privacyVersion: "privacy-v1", acceptedAt: now, explanationShownAt: now, source: "test" },
      auditEvent: { ...audit("evt_consent", "consent_accepted", "emp_consent"), metadata: { privacyVersion: "privacy-v1" } },
    });
    expect(accepted.created).toBe(true);
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

  it("deletes every employee-owned private record", async () => {
    await issueProfileReadyParticipant(pool, "emp_delete", "invite_delete");
    const conversations = createPostgresConversationStore(pool);
    await conversations.appendTurn({ messageId: "msg_delete", employeeId: "emp_delete", threadId: "thread_delete", userText: "private", agentResponse: "reply", timestamp: now });
    await createPostgresFeedbackStore(pool).saveFeedback({ id: "fb_delete", employeeId: "emp_delete", threadId: "thread_delete", targetMessageId: "msg_delete", rating: "positive", source: "test", updatedAt: now });
    await createPostgresInsightStore(pool).saveInsights([{
      id: "ins_delete", employeeId: "emp_delete", threadId: "thread_delete", sourceMessageId: "msg_delete",
      kind: "task_category", label: "reporting", confidence: "low", category: "reporting", createdAt: now,
    }]);
    await createPostgresTelegramSessionStore(pool, config.telegramIdentityPepper).claim({
      identity: { chatId: "chat_delete", userId: "user_delete" },
      session: { employeeId: "emp_delete", threadId: "thread_delete", createdAt: now, updatedAt: now },
    });
    await createPostgresAuditEventStore(pool).append({ id: "evt_delete", requestId: "req_delete", type: "chat_received", employeeId: "emp_delete", occurredAt: now, metadata: {} });
    await createPostgresProfileStore(pool, config.inviteCodePepper).deleteEmployeePersonalData("emp_delete");
    for (const table of ["participants", "profiles", "consents", "threads", "messages", "feedback", "insights", "telegram_sessions"]) {
      const result = await pool.query(`SELECT 1 FROM minutka_private.${table} WHERE employee_id = 'emp_delete'`);
      expect(result.rowCount).toBe(0);
    }
    expect((await pool.query("SELECT 1 FROM minutka_audit.events WHERE employee_id = 'emp_delete'"))).toMatchObject({ rowCount: 0 });
    expect((await pool.query("SELECT 1 FROM minutka_audit.events WHERE event_type = 'employee_data_deleted' AND employee_id IS NULL AND metadata = '{}'::jsonb"))).toMatchObject({ rowCount: 1 });
  });
});
