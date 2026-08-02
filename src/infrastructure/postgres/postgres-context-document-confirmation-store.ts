import type { Pool } from "pg";
import {
  contextDocumentPayloadDigest,
  copyContextDocumentOutcome,
  normalizeContextDocumentProposal,
  type ContextDocumentConfirmationStore,
  type ContextDocumentMutationOutcome,
  type ContextDocumentMutationProposal,
} from "../../application/context-document-service.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

const outcomes = new Set(["updated", "moved", "deleted", "not_found", "conflict", "destination_conflict"]);
type Row = {
  confirmation_id: string;
  user_id: string;
  payload: unknown;
  payload_digest: string;
  expires_at: Date;
  completed_at: Date | null;
  decision: "confirmed" | "rejected" | null;
  outcome: unknown | null;
};

export function createPostgresContextDocumentConfirmationStore(pool: Pool): ContextDocumentConfirmationStore {
  return {
    async save(record) {
      try {
        await pool.query(
          `INSERT INTO minutka_private.context_document_confirmations
            (confirmation_id,user_id,payload,payload_digest,created_at,expires_at)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
          [record.confirmationId, record.ownerId, JSON.stringify(record.proposal), record.payloadDigest, record.createdAt, record.expiresAt],
        );
      } catch (error) { throw mapPostgresError(error); }
    },
    async decide(input, effect) {
      try {
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Row>(
            "SELECT * FROM minutka_private.context_document_confirmations WHERE confirmation_id=$1 FOR UPDATE",
            [input.confirmationId],
          );
          const row = selected.rows[0];
          if (!row) return { result: { status: "not_found" } };
          if (row.user_id !== input.ownerId) return { result: { status: "owner_mismatch" } };
          const proposal = restoreProposal(row);
          if (!proposal) return { result: { status: "invalid_payload" } };
          if (row.decision === "confirmed" && row.outcome !== null) return { result: { status: "already_confirmed", outcome: restoreOutcome(row.outcome) }, proposal };
          if (row.decision === "rejected") return { result: { status: "already_rejected" }, proposal };
          if (row.completed_at !== null || row.outcome !== null) return { result: { status: "invalid_payload" }, proposal };
          if (row.expires_at.getTime() <= Date.parse(input.decidedAt)) return { result: { status: "expired" }, proposal };
          if (input.decision === "reject") {
            await client.query(
              "UPDATE minutka_private.context_document_confirmations SET completed_at=$2, decision='rejected' WHERE confirmation_id=$1",
              [input.confirmationId, input.decidedAt],
            );
            return { result: { status: "rejected" }, proposal };
          }
          const outcome = await effect(proposal);
          await client.query(
            "UPDATE minutka_private.context_document_confirmations SET completed_at=$2, decision='confirmed', outcome=$3::jsonb WHERE confirmation_id=$1",
            [input.confirmationId, input.decidedAt, JSON.stringify(outcome)],
          );
          return { result: { status: "confirmed", outcome: copyContextDocumentOutcome(outcome) }, proposal };
        });
      } catch (error) { throw mapPostgresError(error); }
    },
    async purge(input) {
      try {
        const result = await pool.query(
          `WITH candidates AS (
             SELECT confirmation_id FROM minutka_private.context_document_confirmations
             WHERE (completed_at IS NULL AND expires_at < $1)
                OR (completed_at IS NOT NULL AND completed_at < $2)
             ORDER BY COALESCE(completed_at, expires_at), confirmation_id
             LIMIT $3 FOR UPDATE SKIP LOCKED
           )
           DELETE FROM minutka_private.context_document_confirmations confirmations
           USING candidates WHERE confirmations.confirmation_id=candidates.confirmation_id`,
          [input.pendingExpiredBefore, input.completedBefore, input.limit],
        );
        return result.rowCount ?? 0;
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

function restoreProposal(row: Row): ContextDocumentMutationProposal | null {
  try {
    const proposal = normalizeContextDocumentProposal(row.payload as ContextDocumentMutationProposal);
    return contextDocumentPayloadDigest(proposal) === row.payload_digest ? proposal : null;
  } catch { return null; }
}

function restoreOutcome(value: unknown): ContextDocumentMutationOutcome {
  if (!value || typeof value !== "object" || !outcomes.has(String((value as { outcome?: unknown }).outcome))) throw new Error("invalid stored context document outcome");
  return copyContextDocumentOutcome(value as ContextDocumentMutationOutcome);
}
