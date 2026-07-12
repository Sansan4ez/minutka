import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../../src/infrastructure/postgres/postgres-pool.js";
import { migratePostgres } from "../../src/infrastructure/postgres/postgres-migrator.js";
import { createPostgresProfileStore } from "../../src/infrastructure/postgres/postgres-profile-store.js";
import { createPostgresConversationStore } from "../../src/infrastructure/postgres/postgres-conversation-store.js";
import { createPostgresFeedbackStore } from "../../src/infrastructure/postgres/postgres-feedback-store.js";
import { createPostgresAuditEventStore } from "../../src/infrastructure/postgres/postgres-audit-event-store.js";
import { createPostgresConsentAcceptanceStore } from "../../src/infrastructure/postgres/postgres-consent-acceptance-store.js";
import { createPostgresTelegramInviteRedemptionStore } from "../../src/infrastructure/postgres/postgres-telegram-invite-redemption-store.js";

const url = process.env.TEST_DATABASE_URL;
const describePostgres = url ? describe : describe.skip;
const config = {
  databaseUrl: url!,
  ssl: false as const,
  max: 2,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMillis: 5_000,
  inviteCodePepper: "test-invite-pepper",
  telegramIdentityPepper: "test-telegram-pepper",
};
const now = "2026-07-12T00:00:00.000Z";

function audit(id: string, type: "invite_opened" | "consent_accepted", employeeId?: string) {
  return { id, requestId: `req_${id}`, type, employeeId, occurredAt: now, metadata: {} };
}

async function issueProfileReadyParticipant(employeeId: string, inviteCode: string) {
  const pool = createPostgresPool(config);
  const profiles = createPostgresProfileStore(pool, config.inviteCodePepper);
  await profiles.issueInvite({ employeeId, inviteCode, issuedAt: now });
  await profiles.openInvite({ inviteCode, openedAt: now, explanationShownAt: now });
  await profiles.acceptConsent({ employeeId, privacyVersion: "privacy-v1", acceptedAt: now, explanationShownAt: now, source: "test" });
  await profiles.completeProfile({ completedAt: now, profile: { employeeId, role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now } });
  return { pool, profiles };
}

describePostgres("PostgreSQL storage contracts", () => {
  let pool = createPostgresPool(config);

  beforeAll(async () => {
    await migratePostgres(pool);
    await pool.query("TRUNCATE minutka_audit.events, minutka_private.feedback, minutka_private.insights, minutka_private.messages, minutka_private.threads, minutka_private.telegram_sessions, minutka_private.profiles, minutka_private.consents, minutka_private.participants CASCADE");
  });
  afterAll(() => pool.end());

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
    const sessions = await pool.query("SELECT employee_id FROM minutka_private.telegram_sessions WHERE employee_id = 'emp_claim'");
    const events = await pool.query("SELECT event_type FROM minutka_audit.events WHERE employee_id = 'emp_claim' AND event_type = 'invite_opened'");
    expect(sessions.rowCount).toBe(1);
    expect(events.rowCount).toBe(1);
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
    const first = await issueProfileReadyParticipant("emp_owner_a", "invite_owner_a");
    const second = await issueProfileReadyParticipant("emp_owner_b", "invite_owner_b");
    await first.pool.end();
    await second.pool.end();
    const conversations = createPostgresConversationStore(pool);
    await conversations.appendTurn({ messageId: "msg_owner_a", employeeId: "emp_owner_a", threadId: "thread_owner_a", userText: "private", agentResponse: "reply", timestamp: now });
    await conversations.appendTurn({ messageId: "msg_owner_b", employeeId: "emp_owner_b", threadId: "thread_owner_b", userText: "private", agentResponse: "reply", timestamp: now });
    await expect(pool.query("INSERT INTO minutka_private.feedback(feedback_id, employee_id, thread_id, target_message_id, rating, source, created_at, updated_at) VALUES ('fb_cross', 'emp_owner_a', 'thread_owner_a', 'msg_owner_b', 'positive', 'test', $1, $1)", [now])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO minutka_private.insights(insight_id, employee_id, thread_id, source_message_id, kind, label, confidence, payload, created_at) VALUES ('ins_cross', 'emp_owner_a', 'thread_owner_a', 'msg_owner_b', 'task_category', 'cross', 'low', '{}', $1)", [now])).rejects.toMatchObject({ code: "23503" });
  });
});
