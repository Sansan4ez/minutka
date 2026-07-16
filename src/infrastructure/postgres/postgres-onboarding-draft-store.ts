import type { Pool } from "pg";
import type { OnboardingDraftStore } from "../../application/onboarding-draft-store.js";
import type { OnboardingDraft } from "../../application/onboarding-types.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";

type DraftRow = {
  employee_id: string;
  preferred_name: string | null;
  assistant_name: string | null;
  address_form: OnboardingDraft["addressForm"] | null;
  persona: OnboardingDraft["persona"] | null;
  response_length: OnboardingDraft["responseLength"] | null;
  timezone: string | null;
  status: OnboardingDraft["status"];
  pending_field: OnboardingDraft["pendingField"] | null;
  revision: number; created_at: Date; updated_at: Date; expires_at: Date;
};
const toDraft = (row: DraftRow): OnboardingDraft => ({
  employeeId: row.employee_id,
  ...(row.preferred_name ? { preferredName: row.preferred_name } : {}),
  ...(row.assistant_name ? { assistantName: row.assistant_name } : {}),
  ...(row.address_form ? { addressForm: row.address_form } : {}),
  ...(row.persona ? { persona: row.persona } : {}),
  ...(row.response_length ? { responseLength: row.response_length } : {}),
  ...(row.timezone ? { timezone: row.timezone } : {}),
  status: row.status,
  ...(row.pending_field ? { pendingField: row.pending_field } : {}), revision: row.revision,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), expiresAt: row.expires_at.toISOString(),
});

const columns = "employee_id, preferred_name, assistant_name, address_form, persona, response_length, timezone, status, pending_field, revision, created_at, updated_at, expires_at";
function values(draft: OnboardingDraft, expectedRevision?: number): unknown[] {
  return [draft.employeeId, draft.preferredName ?? null, draft.assistantName ?? null, draft.addressForm ?? null,
    draft.persona ?? null, draft.responseLength ?? null, draft.timezone ?? null, draft.status, draft.pendingField ?? null,
    draft.revision, draft.createdAt, draft.updatedAt, draft.expiresAt, expectedRevision ?? null];
}

export function createPostgresOnboardingDraftStore(pool: Pool): OnboardingDraftStore {
  return {
    async get(employeeId) {
      try {
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
          `INSERT INTO minutka_private.onboarding_drafts (${columns})
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
           WHERE EXISTS (
             SELECT 1 FROM minutka_private.participants
             WHERE employee_id = $1 AND status <> 'profile_completed'
           )
           ON CONFLICT (employee_id) DO UPDATE SET
             preferred_name=EXCLUDED.preferred_name, assistant_name=EXCLUDED.assistant_name,
             address_form=EXCLUDED.address_form, persona=EXCLUDED.persona,
             response_length=EXCLUDED.response_length, timezone=EXCLUDED.timezone,
             status=EXCLUDED.status, pending_field=EXCLUDED.pending_field, revision=EXCLUDED.revision,
             updated_at=EXCLUDED.updated_at, expires_at=EXCLUDED.expires_at
           WHERE ($14::integer IS NULL OR minutka_private.onboarding_drafts.revision = $14)
             AND minutka_private.onboarding_drafts.expires_at > now()
           RETURNING *`, values(draft, expectedRevision),
        );
        if (!result.rows[0]) throw new PersistenceError("persistence_conflict");
        return toDraft(result.rows[0]);
      } catch (error) { if (error instanceof PersistenceError) throw error; throw mapPostgresError(error); }
    },
    async replace(draft) {
      try {
        const result = await pool.query<DraftRow>(
          `INSERT INTO minutka_private.onboarding_drafts (${columns})
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
           WHERE EXISTS (
             SELECT 1 FROM minutka_private.participants
             WHERE employee_id = $1 AND status <> 'profile_completed'
           )
           ON CONFLICT (employee_id) DO UPDATE SET
             preferred_name=EXCLUDED.preferred_name, assistant_name=EXCLUDED.assistant_name,
             address_form=EXCLUDED.address_form, persona=EXCLUDED.persona,
             response_length=EXCLUDED.response_length, timezone=EXCLUDED.timezone,
             status=EXCLUDED.status, pending_field=EXCLUDED.pending_field, revision=EXCLUDED.revision,
             created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, expires_at=EXCLUDED.expires_at
           RETURNING *`, values(draft).slice(0, 13),
        );
        if (!result.rows[0]) throw new PersistenceError("persistence_conflict");
        return toDraft(result.rows[0]);
      } catch (error) { if (error instanceof PersistenceError) throw error; throw mapPostgresError(error); }
    },
    async delete(employeeId) {
      try { await pool.query("DELETE FROM minutka_private.onboarding_drafts WHERE employee_id = $1", [employeeId]); }
      catch (error) { throw mapPostgresError(error); }
    },
    async purgeExpired() {
      try {
        const result = await pool.query("DELETE FROM minutka_private.onboarding_drafts WHERE expires_at <= now()");
        return result.rowCount ?? 0;
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}
