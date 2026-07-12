import type { Consent, Participant, UserProfile } from "../../domain/employee.js";
import type { ProfileStore } from "../../application/profile-store.js";
import type { Pool } from "pg";
import { keyedDigest } from "./digests.js";
import { withTransaction } from "./postgres-pool.js";

type ParticipantRow = { employee_id: string; status: Participant["status"]; privacy_explanation_shown_at: Date | null; created_at: Date; updated_at: Date };
const toParticipant = (row: ParticipantRow): Participant => ({ employeeId: row.employee_id, inviteCode: "[redacted]", status: row.status, ...(row.privacy_explanation_shown_at ? { privacyExplanationShownAt: row.privacy_explanation_shown_at.toISOString() } : {}), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

export function createPostgresProfileStore(pool: Pool, inviteCodePepper: string): ProfileStore {
  return {
    async issueInvite({ employeeId, inviteCode, issuedAt }) {
      const digest = keyedDigest(inviteCode, inviteCodePepper);
      return withTransaction(pool, async (client) => {
        const existingByInvite = await client.query<ParticipantRow>("SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at FROM minutka_private.participants WHERE invite_code_digest = $1 FOR UPDATE", [digest]);
        if (existingByInvite.rowCount) return { participant: toParticipant(existingByInvite.rows[0]), created: false, inviteMatches: existingByInvite.rows[0].employee_id === employeeId };
        const existingByEmployee = await client.query<ParticipantRow>("SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at FROM minutka_private.participants WHERE employee_id = $1 FOR UPDATE", [employeeId]);
        if (existingByEmployee.rowCount) return { participant: toParticipant(existingByEmployee.rows[0]), created: false, inviteMatches: false };
        const inserted = await client.query<ParticipantRow>("INSERT INTO minutka_private.participants(employee_id, invite_code_digest, status, created_at, updated_at) VALUES ($1, $2, 'invite_issued', $3, $3) RETURNING employee_id, status, privacy_explanation_shown_at, created_at, updated_at", [employeeId, digest, issuedAt]);
        return { participant: toParticipant(inserted.rows[0]), created: true, inviteMatches: true };
      });
    },
    async openInvite({ inviteCode, openedAt, explanationShownAt }) {
      const digest = keyedDigest(inviteCode, inviteCodePepper);
      return withTransaction(pool, async (client) => {
        const result = await client.query<ParticipantRow>("SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at FROM minutka_private.participants WHERE invite_code_digest = $1 FOR UPDATE", [digest]);
        if (!result.rowCount) return undefined;
        const current = result.rows[0];
        if (current.status !== "invite_issued") return { participant: toParticipant(current), opened: false };
        const updated = await client.query<ParticipantRow>("UPDATE minutka_private.participants SET status = 'invite_opened', updated_at = $2, privacy_explanation_shown_at = $3 WHERE employee_id = $1 RETURNING employee_id, status, privacy_explanation_shown_at, created_at, updated_at", [current.employee_id, openedAt, explanationShownAt]);
        return { participant: toParticipant(updated.rows[0]), opened: true };
      });
    },
    async acceptConsent(consent) {
      return withTransaction(pool, async (client) => {
        const inserted = await client.query<{ employee_id: string; privacy_version: Consent["privacyVersion"]; accepted_at: Date; explanation_shown_at: Date; source: Consent["source"] }>("INSERT INTO minutka_private.consents(employee_id, privacy_version, accepted_at, explanation_shown_at, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (employee_id) DO NOTHING RETURNING *", [consent.employeeId, consent.privacyVersion, consent.acceptedAt, consent.explanationShownAt, consent.source]);
        const row = inserted.rows[0] ?? (await client.query<{ employee_id: string; privacy_version: Consent["privacyVersion"]; accepted_at: Date; explanation_shown_at: Date; source: Consent["source"] }>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [consent.employeeId])).rows[0];
        if (inserted.rowCount) await client.query("UPDATE minutka_private.participants SET status = CASE WHEN status = 'profile_completed' THEN status ELSE 'consent_accepted' END, updated_at = $2 WHERE employee_id = $1", [consent.employeeId, consent.acceptedAt]);
        return { consent: { employeeId: row.employee_id, privacyVersion: row.privacy_version, acceptedAt: row.accepted_at.toISOString(), explanationShownAt: row.explanation_shown_at.toISOString(), source: row.source }, created: Boolean(inserted.rowCount) };
      });
    },
    async recordPrivacyExplanationShown({ employeeId, shownAt }) {
      const result = await pool.query(
        "UPDATE minutka_private.participants SET privacy_explanation_shown_at = $2, updated_at = $2 WHERE employee_id = $1",
        [employeeId, shownAt],
      );
      if (result.rowCount !== 1) throw new Error("participant not found");
    },
    async completeProfile({ profile, completedAt }) {
      return withTransaction(pool, async (client) => {
        const participant = await client.query<{ status: Participant["status"] }>("SELECT status FROM minutka_private.participants WHERE employee_id = $1 FOR UPDATE", [profile.employeeId]);
        if (!participant.rowCount) throw new Error("participant not found");
        await client.query("INSERT INTO minutka_private.profiles(employee_id, role, typical_tasks, persona, ai_level, response_length, preferred_checkins_per_day, created_at, updated_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9) ON CONFLICT (employee_id) DO UPDATE SET role=EXCLUDED.role, typical_tasks=EXCLUDED.typical_tasks, persona=EXCLUDED.persona, ai_level=EXCLUDED.ai_level, response_length=EXCLUDED.response_length, preferred_checkins_per_day=EXCLUDED.preferred_checkins_per_day, updated_at=EXCLUDED.updated_at", [profile.employeeId, profile.role, JSON.stringify(profile.typicalTasks), profile.persona, profile.aiLevel, profile.responseLength, profile.preferredCheckinsPerDay ?? null, profile.createdAt, profile.updatedAt]);
        await client.query("UPDATE minutka_private.participants SET status = 'profile_completed', updated_at = $2 WHERE employee_id = $1", [profile.employeeId, completedAt]);
        return { profile, wasCompleted: participant.rows[0].status === "profile_completed" };
      });
    },
    async getParticipant(employeeId) { const result = await pool.query<ParticipantRow>("SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at FROM minutka_private.participants WHERE employee_id = $1", [employeeId]); return result.rows[0] ? toParticipant(result.rows[0]) : undefined; },
    async getConsent(employeeId) { const result = await pool.query<{ employee_id: string; privacy_version: Consent["privacyVersion"]; accepted_at: Date; explanation_shown_at: Date; source: Consent["source"] }>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [employeeId]); const row = result.rows[0]; return row ? { employeeId: row.employee_id, privacyVersion: row.privacy_version, acceptedAt: row.accepted_at.toISOString(), explanationShownAt: row.explanation_shown_at.toISOString(), source: row.source } : undefined; },
    async getProfile(employeeId) { const result = await pool.query<{ employee_id: string; role: string; typical_tasks: string[]; persona: UserProfile["persona"]; ai_level: UserProfile["aiLevel"]; response_length: UserProfile["responseLength"]; preferred_checkins_per_day: 1 | 2 | 3 | null; created_at: Date; updated_at: Date }>("SELECT * FROM minutka_private.profiles WHERE employee_id = $1", [employeeId]); const row = result.rows[0]; return row ? { employeeId: row.employee_id, role: row.role, typicalTasks: row.typical_tasks, persona: row.persona, aiLevel: row.ai_level, responseLength: row.response_length, ...(row.preferred_checkins_per_day ? { preferredCheckinsPerDay: row.preferred_checkins_per_day } : {}), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() } : undefined; },
    async deleteEmployeePersonalData(employeeId) {
      await withTransaction(pool, async (client) => {
        // Audit rows are not transcript copies, but employee linkage is still personal data.
        await client.query("DELETE FROM minutka_audit.events WHERE employee_id = $1", [employeeId]);
        await client.query("DELETE FROM minutka_private.participants WHERE employee_id = $1", [employeeId]);
      });
    },
  };
}
