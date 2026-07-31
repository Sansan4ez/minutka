import type { Pool } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  copyIdeaMutationResult,
  normalizeProposal,
  type IdeaDeletionConfirmationStore,
  type IdeaDeletionProposal,
} from "../../application/idea-deletion.js";
import type { IdeaMutationResult } from "../../application/idea-store.js";
import { withTransaction } from "./postgres-pool.js";

const ideaMutationOutcomes = new Set(["deleted", "already_deleted", "restored", "unchanged", "not_found", "conflict", "expired"]);

type Row = {
  confirmation_id: string;
  user_id: string;
  payload: unknown;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  decision: "confirmed" | "rejected" | null;
  outcome: unknown | null;
};

export function createPostgresIdeaDeletionConfirmationStore(pool: Pool): IdeaDeletionConfirmationStore {
  return {
    async save(record) {
      try {
        await pool.query(
          `INSERT INTO minutka_private.idea_deletion_confirmations
            (confirmation_id,user_id,payload,created_at,expires_at)
           VALUES ($1,$2,$3::jsonb,$4,$5)`,
          [record.confirmationId, record.ownerId, JSON.stringify(record.proposal), record.createdAt, record.expiresAt],
        );
      } catch (error) { throw mapPostgresError(error); }
    },
    async decide(input) {
      try {
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Row>(
            "SELECT * FROM minutka_private.idea_deletion_confirmations WHERE confirmation_id=$1 FOR UPDATE",
            [input.confirmationId],
          );
          const row = selected.rows[0];
          if (!row || row.user_id !== input.ownerId) return { result: { status: "not_found" } };
          const proposal = restoreProposal(row.payload);
          if (!proposal) return { result: { status: "invalid_payload" } };
          if (row.decision === "confirmed" && row.outcome !== null) return { result: { status: "already_confirmed", outcome: restoreOutcome(row.outcome) }, ideaId: proposal.ideaId };
          if (row.decision === "rejected") return { result: { status: "already_rejected" }, ideaId: proposal.ideaId };
          if (row.completed_at !== null || row.outcome !== null) return { result: { status: "invalid_payload" }, ideaId: proposal.ideaId };
          if (row.expires_at.getTime() <= Date.parse(input.decidedAt)) return { result: { status: "expired" }, ideaId: proposal.ideaId };
          if (input.decision === "reject") {
            await client.query(
              "UPDATE minutka_private.idea_deletion_confirmations SET completed_at=$2, decision='rejected' WHERE confirmation_id=$1",
              [input.confirmationId, input.decidedAt],
            );
            return { result: { status: "rejected" }, ideaId: proposal.ideaId };
          }
          const deleted = await client.query<IdeaRow>(
            `UPDATE minutka_private.ideas
             SET deleted_at=$4, undo_expires_at=$5, last_activity_at=$4, revision=revision+1
             WHERE user_id=$1 AND idea_id=$2 AND revision=$3 AND deleted_at IS NULL
             RETURNING *`,
            [input.ownerId, proposal.ideaId, proposal.expectedRevision, input.decidedAt, input.undoExpiresAt],
          );
          let outcome: IdeaMutationResult;
          if (deleted.rows[0]) outcome = { outcome: "deleted", idea: restoreIdea(deleted.rows[0]) };
          else {
            const selectedIdea = await client.query<IdeaRow>("SELECT * FROM minutka_private.ideas WHERE user_id=$1 AND idea_id=$2", [input.ownerId, proposal.ideaId]);
            const current = selectedIdea.rows[0] ? restoreIdea(selectedIdea.rows[0]) : undefined;
            outcome = !current ? { outcome: "not_found" }
              : current.deletedAt !== undefined ? { outcome: "already_deleted", idea: current }
                : { outcome: "conflict", current };
          }
          await client.query(
            `UPDATE minutka_private.idea_deletion_confirmations
             SET completed_at=$2, decision='confirmed', outcome=$3::jsonb
             WHERE confirmation_id=$1`,
            [input.confirmationId, input.decidedAt, JSON.stringify(outcome)],
          );
          return { result: { status: "confirmed", outcome: copyIdeaMutationResult(outcome) }, ideaId: proposal.ideaId };
        });
      } catch (error) { throw mapPostgresError(error); }
    },
    async purge(input) {
      try {
        const result = await pool.query(
          `WITH candidates AS (
             SELECT confirmation_id
             FROM minutka_private.idea_deletion_confirmations
             WHERE (completed_at IS NULL AND expires_at < $1)
                OR (completed_at IS NOT NULL AND completed_at < $2)
             ORDER BY COALESCE(completed_at, expires_at), confirmation_id
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM minutka_private.idea_deletion_confirmations confirmations
           USING candidates
           WHERE confirmations.confirmation_id = candidates.confirmation_id`,
          [input.pendingExpiredBefore, input.completedBefore, input.limit],
        );
        return result.rowCount ?? 0;
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

type IdeaRow = {
  idea_id: string; user_id: string; project: string; record_type: string; summary: string; source: unknown; status: string;
  created_at: Date; last_activity_at: Date; revision: string | number; deleted_at: Date | null; undo_expires_at: Date | null;
};

function restoreIdea(row: IdeaRow) {
  return {
    id: row.idea_id,
    userId: row.user_id,
    project: row.project,
    type: row.record_type as "money" | "development" | "content" | "people" | "operations" | "knowledge" | "personal",
    summary: row.summary,
    ...(row.source === null ? {} : { source: row.source as { kind: "text"; text: string } | { kind: "blob"; blobKey: string } }),
    status: row.status as "raw" | "discussed" | "planned" | "done" | "dropped",
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    revision: Number(row.revision),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at.toISOString() }),
    ...(row.undo_expires_at === null ? {} : { undoExpiresAt: row.undo_expires_at.toISOString() }),
  };
}

function restoreProposal(value: unknown): IdeaDeletionProposal | null {
  try { return normalizeProposal(value as IdeaDeletionProposal); }
  catch { return null; }
}

function restoreOutcome(value: unknown): IdeaMutationResult {
  if (!value || typeof value !== "object" || !ideaMutationOutcomes.has(String((value as { outcome?: unknown }).outcome))) {
    throw new Error("invalid stored idea deletion outcome");
  }
  return copyIdeaMutationResult(value as IdeaMutationResult);
}
