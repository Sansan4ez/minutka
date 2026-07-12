import type { ConversationStore, ConversationTurn } from "../../application/conversation-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";
import { withTransaction } from "./postgres-pool.js";

type Row = {
  message_id: string;
  employee_id: string;
  thread_id: string;
  user_text: string;
  agent_response: string;
  created_at: Date;
};
const turn = (row: Row): ConversationTurn => ({
  messageId: row.message_id,
  employeeId: row.employee_id,
  threadId: row.thread_id,
  userText: row.user_text,
  agentResponse: row.agent_response,
  timestamp: row.created_at.toISOString(),
});

export function createPostgresConversationStore(pool: Pool): ConversationStore {
  return {
    async appendTurn(input) {
      try {
        await withTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO minutka_private.threads(employee_id, thread_id, created_at, updated_at)
             VALUES ($1,$2,$3,$3)
             ON CONFLICT (employee_id,thread_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
            [input.employeeId, input.threadId, input.timestamp],
          );
          await client.query(
            `INSERT INTO minutka_private.messages(message_id, employee_id, thread_id, user_text, agent_response, created_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [input.messageId, input.employeeId, input.threadId, input.userText, input.agentResponse, input.timestamp],
          );
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getRecentTurns({ employeeId, threadId, limit }) {
      if (limit <= 0) return [];
      try {
        const result = await pool.query<Row>(
          `SELECT message_id, employee_id, thread_id, user_text, agent_response, created_at
           FROM (
             SELECT * FROM minutka_private.messages
             WHERE employee_id = $1 AND thread_id = $2
             ORDER BY created_at DESC, message_id DESC LIMIT $3
           ) recent
           ORDER BY created_at ASC, message_id ASC`,
          [employeeId, threadId, limit],
        );
        return result.rows.map(turn);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getTurnByMessageId({ employeeId, threadId, messageId }) {
      try {
        const result = await pool.query<Row>(
          `SELECT message_id, employee_id, thread_id, user_text, agent_response, created_at
           FROM minutka_private.messages
           WHERE employee_id=$1 AND thread_id=$2 AND message_id=$3`,
          [employeeId, threadId, messageId],
        );
        return result.rows[0] ? turn(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
