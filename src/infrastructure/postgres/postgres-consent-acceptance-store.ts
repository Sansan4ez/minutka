import type { ConsentAcceptanceStore } from "../../application/consent-acceptance-store.js";
import { safeAuditMetadata } from "../../application/audit-event-store.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";
import type { Consent } from "../../domain/employee.js";
import type { Pool } from "pg";
import { withTransaction } from "./postgres-pool.js";
import { keyedDigest } from "./digests.js";

type ConsentRow = {
  employee_id: string;
  privacy_version: Consent["privacyVersion"];
  accepted_at: Date;
  explanation_shown_at: Date;
  source: Consent["source"];
};

export function createPostgresConsentAcceptanceStore(pool: Pool, telegramIdentityPepper?: string): ConsentAcceptanceStore {
  return {
    async accept({ consent, auditEvent, telegramIdentity }) {
      try {
        return await withTransaction(pool, async (client) => {
          const inserted = await client.query<ConsentRow>(
            `INSERT INTO minutka_private.consents(employee_id, privacy_version, accepted_at, explanation_shown_at, source)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (employee_id) DO NOTHING RETURNING *`,
            [consent.employeeId, consent.privacyVersion, consent.acceptedAt, consent.explanationShownAt, consent.source],
          );
          const row = inserted.rows[0] ?? (
            await client.query<ConsentRow>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [consent.employeeId])
          ).rows[0];
          if (!row) throw new PersistenceError("participant_not_found");
          if (telegramIdentity) {
            if (!telegramIdentityPepper) throw new PersistenceError("persistence_unavailable");
            const session = await client.query(
              `UPDATE minutka_private.telegram_sessions
               SET consent_accepted_at = $4, updated_at = $4
               WHERE chat_id_digest = $1
                 AND user_id_digest IS NOT DISTINCT FROM $2
                 AND employee_id = $3`,
              [
                keyedDigest(telegramIdentity.chatId, telegramIdentityPepper),
                telegramIdentity.userId ? keyedDigest(telegramIdentity.userId, telegramIdentityPepper) : null,
                consent.employeeId,
                consent.acceptedAt,
              ],
            );
            if (session.rowCount !== 1) throw new PersistenceError("session_not_found");
          }
          if (!inserted.rowCount) {
            return {
              consent: {
                employeeId: row.employee_id,
                privacyVersion: row.privacy_version,
                acceptedAt: row.accepted_at.toISOString(),
                explanationShownAt: row.explanation_shown_at.toISOString(),
                source: row.source,
              },
              created: false,
            };
          }

          const participant = await client.query(
            `UPDATE minutka_private.participants
             SET status = CASE WHEN status = 'profile_completed' THEN status ELSE 'consent_accepted' END, updated_at = $2
             WHERE employee_id = $1`,
            [consent.employeeId, consent.acceptedAt],
          );
          if (participant.rowCount !== 1) throw new PersistenceError("participant_not_found");
          await client.query(
            `INSERT INTO minutka_audit.events
              (event_id, request_id, event_type, employee_id, thread_id, message_id, metadata, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
            [
              auditEvent.id,
              auditEvent.requestId,
              auditEvent.type,
              auditEvent.employeeId ?? null,
              auditEvent.threadId ?? null,
              auditEvent.messageId ?? null,
              JSON.stringify(safeAuditMetadata(auditEvent.type, auditEvent.metadata)),
              auditEvent.occurredAt,
            ],
          );
          return {
            consent: {
              employeeId: row.employee_id,
              privacyVersion: row.privacy_version,
              acceptedAt: row.accepted_at.toISOString(),
              explanationShownAt: row.explanation_shown_at.toISOString(),
              source: row.source,
            },
            created: true,
          };
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
  };
}
