import { safeAuditMetadata, type AuditEventRecord } from "../../application/audit-event-store.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";
import type {
  TelegramInviteRedemptionResult,
  TelegramInviteRedemptionStore,
} from "../../application/telegram-invite-redemption-store.js";
import type { Pool } from "pg";
import { keyedDigest } from "./digests.js";
import { withTransaction } from "./postgres-pool.js";

type ParticipantRow = { employee_id: string; status: string };

export function createPostgresTelegramInviteRedemptionStore(
  pool: Pool,
  inviteCodePepper: string,
  telegramIdentityPepper: string,
): TelegramInviteRedemptionStore {
  return {
    async redeem(input): Promise<TelegramInviteRedemptionResult> {
      const inviteDigest = keyedDigest(input.inviteCode, inviteCodePepper);
      const chatDigest = keyedDigest(input.identity.chatId, telegramIdentityPepper);
      const userDigest = input.identity.userId
        ? keyedDigest(input.identity.userId, telegramIdentityPepper)
        : null;

      try {
        return await withTransaction(pool, async (client) => {
          // Serialise claims for the same bearer invite, then rely on the two
          // database uniqueness constraints for independently missing sessions.
          const participant = await client.query<ParticipantRow>(
            "SELECT employee_id, status FROM minutka_private.participants WHERE invite_code_digest = $1 FOR UPDATE",
            [inviteDigest],
          );
          if (!participant.rowCount) return { status: "invite_not_found" };
          const current = participant.rows[0];

          const inserted = await client.query(
            `INSERT INTO minutka_private.telegram_sessions
              (chat_id_digest, user_id_digest, employee_id, thread_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT DO NOTHING
             RETURNING employee_id`,
            [chatDigest, userDigest, current.employee_id, current.employee_id, input.occurredAt],
          );
          if (!inserted.rowCount) {
            const [existingChat, existingEmployee] = await Promise.all([
              client.query("SELECT 1 FROM minutka_private.telegram_sessions WHERE chat_id_digest = $1", [chatDigest]),
              client.query("SELECT 1 FROM minutka_private.telegram_sessions WHERE employee_id = $1", [current.employee_id]),
            ]);
            if (existingChat.rowCount) return { status: "chat_already_linked" };
            if (existingEmployee.rowCount) return { status: "employee_already_linked" };
            throw new PersistenceError("persistence_conflict");
          }

          if (current.status === "invite_issued") {
            await client.query(
              "UPDATE minutka_private.participants SET status = 'invite_opened', updated_at = $2 WHERE employee_id = $1",
              [current.employee_id, input.occurredAt],
            );
          }
          await appendAuditEvent(client, { ...input.auditEvent, employeeId: current.employee_id });
          return {
            status: "claimed",
            employeeId: current.employee_id,
            threadId: current.employee_id,
          };
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
  };
}

async function appendAuditEvent(
  client: Parameters<Parameters<typeof withTransaction>[1]>[0],
  event: AuditEventRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO minutka_audit.events
      (event_id, request_id, event_type, employee_id, thread_id, message_id, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      event.id,
      event.requestId,
      event.type,
      event.employeeId ?? null,
      event.threadId ?? null,
      event.messageId ?? null,
      JSON.stringify(safeAuditMetadata(event.type, event.metadata)),
      event.occurredAt,
    ],
  );
}
