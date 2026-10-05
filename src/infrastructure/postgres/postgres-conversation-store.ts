import type { ConversationStore, ConversationTurn } from "../../application/conversation-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { isDeepStrictEqual } from "node:util";
import { PersistenceError } from "../../application/persistence-error.js";
import { metadataFor, mergeDeliveryEvents, selectEvents, validateEvents, type RetrospectiveEventStore, type TurnMetadata } from "../../application/retrospective-event-store.js";
import type { Pool } from "pg";
import { withTransaction } from "./postgres-pool.js";

type Row = {
  metadata: TurnMetadata | null;
  message_id: string;
  employee_id: string;
  subject_key: string;
  thread_id: string;
  user_text: string;
  agent_response: string;
  created_at: Date;
};
const turn = (row: Row): ConversationTurn => ({
  messageId: row.message_id,
  employeeId: row.employee_id,
  subjectKey: row.subject_key,
  threadId: row.thread_id,
  userText: row.user_text,
  agentResponse: row.agent_response,
  timestamp: row.created_at.toISOString(),
  ...(row.metadata?.origin === undefined ? {} : { origin: row.metadata.origin }),
  ...(row.metadata?.retrospectiveDeliveryScope ? { retrospectiveDeliveryScope: row.metadata.retrospectiveDeliveryScope } : {}),
  ...(row.metadata?.scheduledProvenance ? { scheduledProvenance: row.metadata.scheduledProvenance } : {}),
  ...(row.metadata?.retrospectiveEvents === undefined ? {} : { retrospectiveEvents: row.metadata.retrospectiveEvents }),
});

export function createPostgresConversationStore(pool: Pool): ConversationStore & RetrospectiveEventStore {
  return {
    async appendTurn(input) {
      validateEvents(input, input.retrospectiveEvents ?? []);
      const metadata = metadataFor(input);
      try {
        await withTransaction(pool, async (client) => {
          const events = input.retrospectiveEvents ?? [];
          if (events.length) {
            const owner = await client.query(`SELECT company_id, group_id, subject_key FROM minutka_private.participants WHERE employee_id=$1`, [input.employeeId]);
            const row = owner.rows[0];
            if (!row || events.some((event) => event.companyId !== row.company_id || event.groupId !== row.group_id || event.subjectKey !== row.subject_key)) {
              throw new PersistenceError("persistence_conflict");
            }
          }
          await client.query(
            `INSERT INTO minutka_private.threads(employee_id, thread_id, created_at, updated_at)
             VALUES ($1,$2,$3,$3)
             ON CONFLICT (employee_id,thread_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
            [input.employeeId, input.threadId, input.timestamp],
          );
          const inserted = await client.query(
            `INSERT INTO minutka_private.messages(message_id, employee_id, subject_key, thread_id, user_text, agent_response, created_at, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
            [input.messageId, input.employeeId, input.subjectKey, input.threadId, input.userText, input.agentResponse, input.timestamp, metadata],
          );
          if (!inserted.rowCount) {
            const existing = await client.query<Row>(`SELECT * FROM minutka_private.messages WHERE message_id=$1`, [input.messageId]);
            if (!existing.rows[0] || !isDeepStrictEqual(turn(existing.rows[0]), input)) throw new PersistenceError("persistence_conflict");
          }
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async readEvents(request) {
      if (request.limit <= 0) return [];
      try {
        const result = await pool.query<{ event: import("../../domain/work-retrospective.js").WorkRetrospectiveEvent }>(
          `SELECT event FROM minutka_private.messages m
           CROSS JOIN LATERAL jsonb_array_elements(COALESCE(metadata->'retrospectiveEvents', '[]'::jsonb) || COALESCE(metadata->'deliveryEvents', '[]'::jsonb)) event
           WHERE m.employee_id=$1 AND m.thread_id=$2
             AND event->>'companyId'=$3 AND event->>'groupId'=$4 AND event->>'subjectKey'=$5
             AND ($6::text IS NULL OR event->>'episodeId'=$6)
             AND ($7::timestamptz IS NULL OR (event->>'timestamp')::timestamptz >= $7)
             AND ($8::timestamptz IS NULL OR (event->>'timestamp')::timestamptz <= $8)
           ORDER BY (event->>'timestamp')::timestamptz, event->>'sourceMessageId', (event->>'ordinal')::int LIMIT $9`,
          [request.scope.employeeId, request.scope.threadId, request.scope.companyId, request.scope.groupId, request.scope.subjectKey,
            request.episodeId ?? null, request.period?.start ?? null, request.period?.end ?? null, request.limit]);
        return selectEvents(result.rows.map((row) => row.event), request);
      } catch (error) { throw mapPostgresError(error); }
    },
    async appendDeliveryEvents(request) {
      try {
        await withTransaction(pool, async (client) => {
          const result = await client.query<Row>(`SELECT * FROM minutka_private.messages WHERE employee_id=$1 AND thread_id=$2 AND message_id=$3 FOR UPDATE`,
            [request.scope.employeeId, request.scope.threadId, request.sourceMessageId]);
          const row = result.rows[0];
          if (!row) throw new PersistenceError("message_not_found");
          const metadata = mergeDeliveryEvents(turn(row), row.metadata, request.scope, request.events);
          await client.query(`UPDATE minutka_private.messages SET metadata=$1 WHERE message_id=$2`, [metadata, request.sourceMessageId]);
        });
      } catch (error) { throw mapPostgresError(error); }
    },
    async getRecentTurns({ employeeId, threadId, limit }) {
      if (limit <= 0) return [];
      try {
        const result = await pool.query<Row>(
          `SELECT message_id, employee_id, subject_key, thread_id, user_text, agent_response, created_at, metadata
           FROM (
             SELECT message_id, employee_id, subject_key, thread_id, user_text, agent_response, created_at, metadata FROM minutka_private.messages
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
    async getTurnsBeforeRecent({ employeeId, threadId, recentLimit, limit, afterMessageId }) {
      if (limit <= 0) return [];
      try {
        const result = await pool.query<Row>(
          `WITH ordered AS (
             SELECT message_id, employee_id, subject_key, thread_id, user_text, agent_response, created_at, metadata,
                    row_number() OVER (ORDER BY created_at DESC, message_id DESC) AS recent_position
             FROM minutka_private.messages
             WHERE employee_id = $1 AND thread_id = $2
           ), watermark AS (
             SELECT created_at, message_id
             FROM minutka_private.messages
             WHERE employee_id = $1 AND thread_id = $2 AND message_id = $4
           )
           SELECT ordered.message_id, ordered.employee_id, ordered.subject_key, ordered.thread_id, ordered.user_text, ordered.agent_response, ordered.created_at, ordered.metadata
           FROM ordered
           WHERE ordered.recent_position > $3
             AND ($4::text IS NULL OR NOT EXISTS (SELECT 1 FROM watermark)
               OR (ordered.created_at, ordered.message_id) > (SELECT created_at, message_id FROM watermark))
           ORDER BY ordered.created_at ASC, ordered.message_id ASC
           LIMIT $5`,
          [employeeId, threadId, Math.max(0, recentLimit), afterMessageId ?? null, limit],
        );
        return result.rows.map(turn);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getTurnByMessageId({ employeeId, threadId, messageId }) {
      try {
        const result = await pool.query<Row>(
          `SELECT message_id, employee_id, subject_key, thread_id, user_text, agent_response, created_at, metadata
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
