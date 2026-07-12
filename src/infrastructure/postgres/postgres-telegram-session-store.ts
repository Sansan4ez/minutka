import type { TelegramSessionStore } from "../../telegram/telegram-session-store.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";
import { keyedDigest } from "./digests.js";
import { withTransaction } from "./postgres-pool.js";

type Row = {
  employee_id: string;
  thread_id: string;
  consent_accepted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const session = (row: Row) => ({
  employeeId: row.employee_id,
  threadId: row.thread_id,
  ...(row.consent_accepted_at ? { consentAcceptedAt: row.consent_accepted_at.toISOString() } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export function createPostgresTelegramSessionStore(pool: Pool, pepper: string): TelegramSessionStore {
  const lookup = async (chatId: string, userId?: string) => {
    const chat = keyedDigest(chatId, pepper);
    const user = userId === undefined ? undefined : keyedDigest(userId, pepper);
    const result = await pool.query<Row>(
      `SELECT employee_id, thread_id, consent_accepted_at, created_at, updated_at
       FROM minutka_private.telegram_sessions
       WHERE chat_id_digest = $1${user ? " AND user_id_digest = $2" : ""}`,
      user ? [chat, user] : [chat],
    );
    return result.rows[0] ? session(result.rows[0]) : undefined;
  };

  return {
    // An identity without userId is an intentional chat-only probe used to
    // distinguish an unlinked account from an unknown chat.
    async getByIdentity(identity) {
      try {
        return await lookup(identity.chatId, identity.userId);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async claim({ identity, session: next }) {
      const chat = keyedDigest(identity.chatId, pepper);
      const user = identity.userId ? keyedDigest(identity.userId, pepper) : null;
      try {
        return await withTransaction(pool, async (client) => {
          const inserted = await client.query<Row>(
            `INSERT INTO minutka_private.telegram_sessions
              (chat_id_digest, user_id_digest, employee_id, thread_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING
             RETURNING employee_id, thread_id, consent_accepted_at, created_at, updated_at`,
            [chat, user, next.employeeId, next.threadId, next.createdAt, next.updatedAt],
          );
          if (inserted.rowCount) return { status: "claimed" as const, session: session(inserted.rows[0]) };

          const [existingChat, existingEmployee] = await Promise.all([
            client.query("SELECT 1 FROM minutka_private.telegram_sessions WHERE chat_id_digest = $1", [chat]),
            client.query("SELECT 1 FROM minutka_private.telegram_sessions WHERE employee_id = $1", [next.employeeId]),
          ]);
          if (existingChat.rowCount) return { status: "chat_already_linked" as const };
          if (existingEmployee.rowCount) return { status: "employee_already_linked" as const };
          throw new PersistenceError("persistence_conflict");
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async markConsentAccepted({ identity, employeeId, acceptedAt }) {
      try {
        const chat = keyedDigest(identity.chatId, pepper);
        const user = identity.userId ? keyedDigest(identity.userId, pepper) : null;
        const result = await pool.query(
          `UPDATE minutka_private.telegram_sessions
           SET consent_accepted_at = $4, updated_at = $4
           WHERE chat_id_digest = $1 AND user_id_digest IS NOT DISTINCT FROM $2 AND employee_id = $3`,
          [chat, user, employeeId, acceptedAt],
        );
        if (result.rowCount !== 1) throw new PersistenceError("participant_not_found");
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
  };
}
