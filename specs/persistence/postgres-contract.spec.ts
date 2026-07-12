import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../../src/infrastructure/postgres/postgres-pool.js";
import { migratePostgres } from "../../src/infrastructure/postgres/postgres-migrator.js";
import { createPostgresProfileStore } from "../../src/infrastructure/postgres/postgres-profile-store.js";
import { createPostgresConversationStore } from "../../src/infrastructure/postgres/postgres-conversation-store.js";
import { createPostgresFeedbackStore } from "../../src/infrastructure/postgres/postgres-feedback-store.js";

const url = process.env.TEST_DATABASE_URL;
const describePostgres = url ? describe : describe.skip;

describePostgres("PostgreSQL storage contracts", () => {
  const pool = createPostgresPool({ databaseUrl: url!, ssl: false, max: 2, connectionTimeoutMillis: 5_000, statementTimeoutMillis: 5_000, inviteCodePepper: "test-invite-pepper", telegramIdentityPepper: "test-telegram-pepper" });
  const profiles = createPostgresProfileStore(pool, "test-invite-pepper");
  const conversations = createPostgresConversationStore(pool);
  const feedback = createPostgresFeedbackStore(pool);
  beforeAll(async () => { await migratePostgres(pool); await pool.query("TRUNCATE minutka_audit.events, minutka_private.feedback, minutka_private.insights, minutka_private.messages, minutka_private.threads, minutka_private.telegram_sessions, minutka_private.profiles, minutka_private.consents, minutka_private.participants CASCADE"); });
  afterAll(() => pool.end());
  it("persists invite, profile, turn and stable feedback upsert across adapter recreation", async () => {
    const now = "2026-07-12T00:00:00.000Z";
    await profiles.issueInvite({ employeeId: "emp_pg", inviteCode: "invite_pg", issuedAt: now });
    await profiles.openInvite({ inviteCode: "invite_pg", openedAt: now, explanationShownAt: now });
    await profiles.acceptConsent({ employeeId: "emp_pg", privacyVersion: "privacy-v1", acceptedAt: now, explanationShownAt: now, source: "test" });
    await profiles.completeProfile({ completedAt: now, profile: { employeeId: "emp_pg", role: "Manager", typicalTasks: ["reports"], persona: "efficiency", aiLevel: "advanced", responseLength: "short", createdAt: now, updatedAt: now } });
    await conversations.appendTurn({ messageId: "msg_pg", employeeId: "emp_pg", threadId: "thread_pg", userText: "morning", agentResponse: "reply", timestamp: now });
    const first = await feedback.saveFeedback({ id: "fb_original", employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg", rating: "positive", source: "test", updatedAt: now });
    const second = await feedback.saveFeedback({ id: "fb_retry", employeeId: "emp_pg", threadId: "thread_pg", targetMessageId: "msg_pg", rating: "negative", source: "test", updatedAt: "2026-07-12T00:01:00.000Z" });
    expect(second.id).toBe(first.id);
    expect((await createPostgresConversationStore(pool).getRecentTurns({ employeeId: "emp_pg", threadId: "thread_pg", limit: 10 }))[0]?.userText).toBe("morning");
  });
});
