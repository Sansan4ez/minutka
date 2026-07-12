import type { ConsentAcceptanceStore } from "../../application/consent-acceptance-store.js";
import type { Consent } from "../../domain/employee.js";
import type { Pool } from "pg";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresConsentAcceptanceStore(pool: Pool): ConsentAcceptanceStore {
  return {
    async accept({ consent, auditEvent }) {
      return withTransaction(pool, async (client) => {
        const inserted = await client.query<{
          employee_id: string;
          privacy_version: Consent["privacyVersion"];
          accepted_at: Date;
          explanation_shown_at: Date;
          source: Consent["source"];
        }>(
          "INSERT INTO minutka_private.consents(employee_id, privacy_version, accepted_at, explanation_shown_at, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (employee_id) DO NOTHING RETURNING *",
          [
            consent.employeeId,
            consent.privacyVersion,
            consent.acceptedAt,
            consent.explanationShownAt,
            consent.source,
          ],
        );
        const row = inserted.rows[0] ?? (
          await client.query<{
            employee_id: string;
            privacy_version: Consent["privacyVersion"];
            accepted_at: Date;
            explanation_shown_at: Date;
            source: Consent["source"];
          }>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [consent.employeeId])
        ).rows[0];

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

        await client.query(
          "UPDATE minutka_private.participants SET status = CASE WHEN status = 'profile_completed' THEN status ELSE 'consent_accepted' END, updated_at = $2 WHERE employee_id = $1",
          [consent.employeeId, consent.acceptedAt],
        );
        await client.query(
          "INSERT INTO minutka_audit.events(event_id, request_id, event_type, employee_id, thread_id, message_id, metadata, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
          [
            auditEvent.id,
            auditEvent.requestId,
            auditEvent.type,
            auditEvent.employeeId ?? null,
            auditEvent.threadId ?? null,
            auditEvent.messageId ?? null,
            JSON.stringify(auditEvent.metadata),
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
    },
  };
}
