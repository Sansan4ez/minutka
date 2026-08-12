import { z } from "zod";
import { definedIdeaPatch, validateIdeaText, type Idea, type IdeaStore } from "../../application/idea-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal("blob"), blobKey: z.string().min(1) }),
]);
const ideaSchema = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  project: z.string().min(1),
  type: z.enum(["money", "development", "content", "people", "operations", "knowledge", "personal"]),
  summary: z.string().min(1),
  source: sourceSchema.optional(),
  status: z.enum(["raw", "discussed", "planned", "done", "dropped"]),
  createdAt: z.string().min(1),
  lastActivityAt: z.string().min(1),
  revision: z.number().int().positive(),
  deletedAt: z.string().min(1).optional(),
  undoExpiresAt: z.string().min(1).optional(),
});
type Row = {
  idea_id: string;
  user_id: string;
  project: string;
  record_type: string;
  summary: string;
  source: unknown;
  status: string;
  created_at: Date;
  last_activity_at: Date;
  revision: string | number;
  deleted_at: Date | null;
  undo_expires_at: Date | null;
};

function restoreIdea(row: Row): Idea {
  return ideaSchema.parse({
    id: row.idea_id,
    userId: row.user_id,
    project: row.project,
    type: row.record_type,
    summary: row.summary,
    ...(row.source === null ? {} : { source: row.source }),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    revision: Number(row.revision),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at.toISOString() }),
    ...(row.undo_expires_at === null ? {} : { undoExpiresAt: row.undo_expires_at.toISOString() }),
  });
}

export function createPostgresIdeaStore(pool: Pool): IdeaStore {
  return {
    async add(input) {
      validateIdeaText(input.project, "project");
      validateIdeaText(input.summary, "summary");
      if (input.source?.kind === "text" && !input.source.text.trim()) throw new Error("source text is required");
      if (input.source?.kind === "blob" && !input.source.blobKey.trim()) throw new Error("source blob key is required");
      try {
        const result = await pool.query<Row>(
          `INSERT INTO minutka_private.ideas
            (idea_id,user_id,project,record_type,summary,source,status,created_at,last_activity_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,now(),now())
           RETURNING *`,
          [input.id, input.userId, input.project, input.type, input.summary, input.source === undefined ? null : JSON.stringify(input.source), input.status],
        );
        return restoreIdea(result.rows[0]!);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async get(userId, id) {
      try {
        const result = await pool.query<Row>(
          "SELECT * FROM minutka_private.ideas WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL",
          [userId, id],
        );
        return result.rows[0] === undefined ? null : restoreIdea(result.rows[0]);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async list(userId, filter, options) {
      const clauses = ["user_id=$1"];
      if (options?.includeDeleted !== true) clauses.push("deleted_at IS NULL");
      const params: unknown[] = [userId];
      if (filter?.project) { params.push(filter.project); clauses.push(`project=$${params.length}`); }
      if (filter?.type) { params.push(filter.type); clauses.push(`record_type=$${params.length}`); }
      if (filter?.status) { params.push(filter.status); clauses.push(`status=$${params.length}`); }
      const limit = validateLimit(options?.limit);
      const order = options?.order === "activity_desc" ? "last_activity_at DESC, idea_id DESC" : "created_at ASC, idea_id ASC";
      if (limit !== undefined) params.push(limit);
      const limitClause = limit === undefined ? "" : ` LIMIT $${params.length}`;
      try {
        const result = await pool.query<Row>(`SELECT * FROM minutka_private.ideas WHERE ${clauses.join(" AND ")} ORDER BY ${order}${limitClause}`, params);
        return result.rows.flatMap((row) => {
          try { return [restoreIdea(row)]; }
          catch { console.warn("Skipped invalid persisted idea."); return []; }
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async stale(userId, days) {
      if (!Number.isFinite(days) || days < 0) throw new Error("days must be a non-negative finite number");
      try {
        const result = await pool.query<Row>(
          `SELECT * FROM minutka_private.ideas
           WHERE user_id=$1 AND deleted_at IS NULL AND status IN ('raw','discussed') AND last_activity_at <= now() - ($2 * interval '1 day')
           ORDER BY last_activity_at ASC, idea_id ASC`,
          [userId, days],
        );
        return result.rows.flatMap((row) => {
          try { return [restoreIdea(row)]; }
          catch { console.warn("Skipped invalid persisted idea."); return []; }
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async update(userId, id, patch) {
      const fields = Object.entries(definedIdeaPatch(patch));
      const column: Record<string, string> = { project: "project", type: "record_type", summary: "summary", source: "source", status: "status" };
      const params: unknown[] = [userId, id];
      const assignments = fields.map(([name, value]) => {
        params.push(name === "source" ? JSON.stringify(value) : value);
        return `${column[name]}=$${params.length}${name === "source" ? "::jsonb" : ""}`;
      });
      if (fields.length === 0) return this.get(userId, id);
      assignments.push("last_activity_at=now()", "revision=revision+1");
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.ideas SET ${assignments.join(", ")} WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL RETURNING *`,
          params,
        );
        return result.rows[0] === undefined ? null : restoreIdea(result.rows[0]);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async append(userId, id, input) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) throw new Error("expectedRevision must be a positive safe integer");
      const text = input.text.trim();
      if (!text) throw new Error("append text is required");
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.ideas
           SET summary=CASE WHEN btrim(summary)='' THEN $4 ELSE rtrim(summary) || E'\\n\\n' || $4 END, last_activity_at=now(), revision=revision+1
           WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL AND revision=$3
           RETURNING *`,
          [userId, id, input.expectedRevision, text],
        );
        if (result.rows[0]) return { status: "applied", idea: restoreIdea(result.rows[0]) };
        const selected = await pool.query<Row>("SELECT * FROM minutka_private.ideas WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL", [userId, id]);
        return selected.rows[0] ? { status: "conflict", current: restoreIdea(selected.rows[0]) } : { status: "not_found" };
      } catch (error) { throw mapPostgresError(error); }
    },
    async softDelete(userId, id, input) {
      const params: unknown[] = [userId, id, input.deletedAt, input.undoExpiresAt];
      const expected = input.expectedRevision === undefined ? "" : ` AND revision=$${params.push(input.expectedRevision)}`;
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.ideas
           SET deleted_at=$3, undo_expires_at=$4, last_activity_at=$3, revision=revision+1
           WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL${expected}
           RETURNING *`,
          params,
        );
        if (result.rows[0]) return { outcome: "deleted", idea: restoreIdea(result.rows[0]) };
        const selected = await pool.query<Row>("SELECT * FROM minutka_private.ideas WHERE user_id=$1 AND idea_id=$2", [userId, id]);
        const current = selected.rows[0];
        if (!current) return { outcome: "not_found" };
        const idea = restoreIdea(current);
        return idea.deletedAt !== undefined ? { outcome: "already_deleted", idea } : { outcome: "conflict", current: idea };
      } catch (error) { throw mapPostgresError(error); }
    },
    async undoDelete(userId, id, input) {
      const params: unknown[] = [userId, id, input.restoredAt];
      const expected = input.expectedRevision === undefined ? "" : ` AND revision=$${params.push(input.expectedRevision)}`;
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.ideas
           SET deleted_at=NULL, undo_expires_at=NULL, last_activity_at=$3, revision=revision+1
           WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NOT NULL AND undo_expires_at >= $3${expected}
           RETURNING *`,
          params,
        );
        if (result.rows[0]) return { outcome: "restored", idea: restoreIdea(result.rows[0]) };
        const selected = await pool.query<Row>("SELECT * FROM minutka_private.ideas WHERE user_id=$1 AND idea_id=$2", [userId, id]);
        const current = selected.rows[0];
        if (!current) return { outcome: "not_found" };
        const idea = restoreIdea(current);
        if (idea.deletedAt === undefined) return { outcome: "unchanged", idea };
        if (idea.undoExpiresAt !== undefined && Date.parse(input.restoredAt) > Date.parse(idea.undoExpiresAt)) return { outcome: "expired" };
        return { outcome: "conflict", current: idea };
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit must be a positive safe integer");
  return limit;
}
