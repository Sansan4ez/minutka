import type { Pool } from "pg";
import type { OnboardingDraftStore } from "../../application/onboarding-draft-store.js";
import type { OnboardingDraft } from "../../application/onboarding-types.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";

type DraftRow = {
  employee_id: string; role: string | null; typical_tasks: string[] | null;
  persona: OnboardingDraft["persona"] | null; ai_level: OnboardingDraft["aiLevel"] | null;
  status: OnboardingDraft["status"]; pending_field: OnboardingDraft["pendingField"] | null;
  revision: number; created_at: Date; updated_at: Date; expires_at: Date;
};
const toDraft = (row: DraftRow): OnboardingDraft => ({
  employeeId: row.employee_id, ...(row.role ? { role: row.role } : {}),
  ...(row.typical_tasks ? { typicalTasks: row.typical_tasks } : {}), ...(row.persona ? { persona: row.persona } : {}),
  ...(row.ai_level ? { aiLevel: row.ai_level } : {}), status: row.status,
  ...(row.pending_field ? { pendingField: row.pending_field } : {}), revision: row.revision,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), expiresAt: row.expires_at.toISOString(),
});

export function createPostgresOnboardingDraftStore(pool: Pool): OnboardingDraftStore {
  return {
    async get(employeeId) {
      try {
        // Remove expired personal data as it is encountered, so a new draft can
        // safely reuse the employee's primary key.
        const result = await pool.query<DraftRow>(
          `DELETE FROM minutka_private.onboarding_drafts
             WHERE employee_id = $1 AND expires_at <= now()
           RETURNING *`, [employeeId],
        );
        if (result.rowCount) return undefined;
        const current = await pool.query<DraftRow>(
          "SELECT * FROM minutka_private.onboarding_drafts WHERE employee_id = $1", [employeeId],
        );
        return current.rows[0] ? toDraft(current.rows[0]) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async save(draft, expectedRevision) {
      try {
        const result = await pool.query<DraftRow>(
          `INSERT INTO minutka_private.onboarding_drafts
             (employee_id, role, typical_tasks, persona, ai_level, status, pending_field, revision, created_at, updated_at, expires_at)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (employee_id) DO UPDATE SET
             role=EXCLUDED.role, typical_tasks=EXCLUDED.typical_tasks, persona=EXCLUDED.persona, ai_level=EXCLUDED.ai_level,
             status=EXCLUDED.status, pending_field=EXCLUDED.pending_field, revision=EXCLUDED.revision,
             updated_at=EXCLUDED.updated_at, expires_at=EXCLUDED.expires_at
           WHERE ($12::integer IS NULL OR minutka_private.onboarding_drafts.revision = $12)
           RETURNING *`,
          [draft.employeeId, draft.role ?? null, draft.typicalTasks ? JSON.stringify(draft.typicalTasks) : null, draft.persona ?? null,
            draft.aiLevel ?? null, draft.status, draft.pendingField ?? null, draft.revision, draft.createdAt, draft.updatedAt,
            draft.expiresAt, expectedRevision ?? null],
        );
        if (!result.rows[0]) throw new PersistenceError("persistence_conflict");
        return toDraft(result.rows[0]);
      } catch (error) { if (error instanceof PersistenceError) throw error; throw mapPostgresError(error); }
    },
    async replace(draft) {
      try {
        const result = await pool.query<DraftRow>(
          `INSERT INTO minutka_private.onboarding_drafts
             (employee_id, role, typical_tasks, persona, ai_level, status, pending_field, revision, created_at, updated_at, expires_at)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (employee_id) DO UPDATE SET
             role=EXCLUDED.role, typical_tasks=EXCLUDED.typical_tasks, persona=EXCLUDED.persona, ai_level=EXCLUDED.ai_level,
             status=EXCLUDED.status, pending_field=EXCLUDED.pending_field, revision=EXCLUDED.revision,
             created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, expires_at=EXCLUDED.expires_at
           RETURNING *`,
          [draft.employeeId, draft.role ?? null, draft.typicalTasks ? JSON.stringify(draft.typicalTasks) : null, draft.persona ?? null,
            draft.aiLevel ?? null, draft.status, draft.pendingField ?? null, draft.revision, draft.createdAt, draft.updatedAt, draft.expiresAt],
        );
        if (!result.rows[0]) throw new PersistenceError("persistence_conflict");
        return toDraft(result.rows[0]);
      } catch (error) { if (error instanceof PersistenceError) throw error; throw mapPostgresError(error); }
    },
    async delete(employeeId) {
      try { await pool.query("DELETE FROM minutka_private.onboarding_drafts WHERE employee_id = $1", [employeeId]); }
      catch (error) { throw mapPostgresError(error); }
    },
  };
}
