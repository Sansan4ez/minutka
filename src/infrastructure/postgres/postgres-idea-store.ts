import { z } from "zod";
import type { Idea, IdeaStore } from "../../application/idea-store.js";
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
  });
}

export function createPostgresIdeaStore(pool: Pool): IdeaStore {
  return {
    async add(input) {
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
    async list(userId, filter) {
      const clauses = ["user_id=$1"];
      const params: string[] = [userId];
      if (filter?.project) { params.push(filter.project); clauses.push(`project=$${params.length}`); }
      if (filter?.type) { params.push(filter.type); clauses.push(`record_type=$${params.length}`); }
      if (filter?.status) { params.push(filter.status); clauses.push(`status=$${params.length}`); }
      try {
        const result = await pool.query<Row>(`SELECT * FROM minutka_private.ideas WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, idea_id ASC`, params);
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
           WHERE user_id=$1 AND status IN ('raw','discussed') AND last_activity_at <= now() - ($2 * interval '1 day')
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
      const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
      const column: Record<string, string> = { project: "project", type: "record_type", summary: "summary", source: "source", status: "status" };
      const params: unknown[] = [userId, id];
      const assignments = fields.map(([name, value]) => {
        params.push(name === "source" ? JSON.stringify(value) : value);
        return `${column[name]}=$${params.length}${name === "source" ? "::jsonb" : ""}`;
      });
      assignments.push("last_activity_at=now()");
      try {
        const result = await pool.query<Row>(
          `UPDATE minutka_private.ideas SET ${assignments.join(", ")} WHERE user_id=$1 AND idea_id=$2 RETURNING *`,
          params,
        );
        return result.rows[0] === undefined ? null : restoreIdea(result.rows[0]);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
