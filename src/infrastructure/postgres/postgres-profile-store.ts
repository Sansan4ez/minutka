import { randomUUID } from "node:crypto";
import type { Consent, Participant, UserProfile } from "../../domain/employee.js";
import { systemClock, type Clock } from "../../application/runtime-primitives.js";
import type { ProfileStore } from "../../application/profile-store.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";
import { keyedDigest } from "./digests.js";
import { withTransaction } from "./postgres-pool.js";

type ParticipantRow = {
  employee_id: string;
  status: Participant["status"];
  privacy_explanation_shown_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type ConsentRow = {
  employee_id: string;
  privacy_version: Consent["privacyVersion"];
  accepted_at: Date;
  explanation_shown_at: Date;
  source: Consent["source"];
};
type ProfileRow = {
  employee_id: string;
  role: string;
  typical_tasks: string[];
  persona: UserProfile["persona"];
  ai_level: UserProfile["aiLevel"];
  response_length: UserProfile["responseLength"];
  preferred_checkins_per_day: 1 | 2 | 3 | null;
  created_at: Date;
  updated_at: Date;
};

const toParticipant = (row: ParticipantRow): Participant => ({
  employeeId: row.employee_id,
  status: row.status,
  ...(row.privacy_explanation_shown_at ? { privacyExplanationShownAt: row.privacy_explanation_shown_at.toISOString() } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const toConsent = (row: ConsentRow): Consent => ({
  employeeId: row.employee_id,
  privacyVersion: row.privacy_version,
  acceptedAt: row.accepted_at.toISOString(),
  explanationShownAt: row.explanation_shown_at.toISOString(),
  source: row.source,
});
const toProfile = (row: ProfileRow): UserProfile => ({
  employeeId: row.employee_id,
  role: row.role,
  typicalTasks: row.typical_tasks,
  persona: row.persona,
  aiLevel: row.ai_level,
  responseLength: row.response_length,
  ...(row.preferred_checkins_per_day ? { preferredCheckinsPerDay: row.preferred_checkins_per_day } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export function createPostgresProfileStore(
  pool: Pool,
  inviteCodePepper: string,
  clock: Clock = systemClock,
): ProfileStore {
  return {
    async issueInvite({ employeeId, inviteCode, issuedAt }) {
      const digest = keyedDigest(inviteCode, inviteCodePepper);
      try {
        return await withTransaction(pool, async (client) => {
          // Conditional insert avoids the missing-row SELECT FOR UPDATE race.
          const inserted = await client.query<ParticipantRow>(
            `INSERT INTO minutka_private.participants(employee_id, invite_code_digest, status, created_at, updated_at)
             VALUES ($1, $2, 'invite_issued', $3, $3)
             ON CONFLICT DO NOTHING
             RETURNING employee_id, status, privacy_explanation_shown_at, created_at, updated_at`,
            [employeeId, digest, issuedAt],
          );
          if (inserted.rowCount) {
            return { participant: toParticipant(inserted.rows[0]), created: true, inviteMatches: true };
          }
          const [existingByInvite, existingByEmployee] = await Promise.all([
            client.query<ParticipantRow>(
              `SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at
               FROM minutka_private.participants WHERE invite_code_digest = $1`,
              [digest],
            ),
            client.query<ParticipantRow>(
              `SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at
               FROM minutka_private.participants WHERE employee_id = $1`,
              [employeeId],
            ),
          ]);
          const participant = existingByInvite.rows[0] ?? existingByEmployee.rows[0];
          if (!participant) throw new PersistenceError("persistence_conflict");
          return {
            participant: toParticipant(participant),
            created: false,
            inviteMatches: existingByInvite.rows[0]?.employee_id === employeeId,
          };
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async openInvite({ inviteCode, openedAt, explanationShownAt }) {
      const digest = keyedDigest(inviteCode, inviteCodePepper);
      try {
        return await withTransaction(pool, async (client) => {
          const updated = await client.query<ParticipantRow>(
            `UPDATE minutka_private.participants
             SET status = 'invite_opened', updated_at = $2, privacy_explanation_shown_at = COALESCE($3, privacy_explanation_shown_at)
             WHERE invite_code_digest = $1 AND status = 'invite_issued'
             RETURNING employee_id, status, privacy_explanation_shown_at, created_at, updated_at`,
            [digest, openedAt, explanationShownAt ?? null],
          );
          if (updated.rowCount) return { participant: toParticipant(updated.rows[0]), opened: true };
          const existing = await client.query<ParticipantRow>(
            `SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at
             FROM minutka_private.participants WHERE invite_code_digest = $1`,
            [digest],
          );
          return existing.rows[0]
            ? { participant: toParticipant(existing.rows[0]), opened: false }
            : undefined;
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async acceptConsent(consent) {
      try {
        return await withTransaction(pool, async (client) => {
          const inserted = await client.query<ConsentRow>(
            `INSERT INTO minutka_private.consents(employee_id, privacy_version, accepted_at, explanation_shown_at, source)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (employee_id) DO NOTHING
             RETURNING *`,
            [consent.employeeId, consent.privacyVersion, consent.acceptedAt, consent.explanationShownAt, consent.source],
          );
          const row = inserted.rows[0] ?? (
            await client.query<ConsentRow>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [consent.employeeId])
          ).rows[0];
          if (!row) throw new PersistenceError("participant_not_found");
          if (inserted.rowCount) {
            const participant = await client.query(
              `UPDATE minutka_private.participants
               SET status = CASE WHEN status = 'profile_completed' THEN status ELSE 'consent_accepted' END, updated_at = $2
               WHERE employee_id = $1`,
              [consent.employeeId, consent.acceptedAt],
            );
            if (participant.rowCount !== 1) throw new PersistenceError("participant_not_found");
          }
          return { consent: toConsent(row), created: Boolean(inserted.rowCount) };
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async recordPrivacyExplanationShown({ employeeId, shownAt }) {
      try {
        const result = await pool.query(
          "UPDATE minutka_private.participants SET privacy_explanation_shown_at = $2, updated_at = $2 WHERE employee_id = $1",
          [employeeId, shownAt],
        );
        if (result.rowCount !== 1) throw new PersistenceError("participant_not_found");
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async completeProfile({ profile, completedAt }) {
      try {
        return await withTransaction(pool, async (client) => {
          const participant = await client.query<{ status: Participant["status"] }>(
            "SELECT status FROM minutka_private.participants WHERE employee_id = $1 FOR UPDATE",
            [profile.employeeId],
          );
          if (!participant.rowCount) throw new PersistenceError("participant_not_found");
          await client.query(
            `INSERT INTO minutka_private.profiles(employee_id, role, typical_tasks, persona, ai_level, response_length, preferred_checkins_per_day, created_at, updated_at)
             VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (employee_id) DO UPDATE SET
               role=EXCLUDED.role, typical_tasks=EXCLUDED.typical_tasks, persona=EXCLUDED.persona,
               ai_level=EXCLUDED.ai_level, response_length=EXCLUDED.response_length,
               preferred_checkins_per_day=EXCLUDED.preferred_checkins_per_day, updated_at=EXCLUDED.updated_at`,
            [profile.employeeId, profile.role, JSON.stringify(profile.typicalTasks), profile.persona, profile.aiLevel, profile.responseLength, profile.preferredCheckinsPerDay ?? null, profile.createdAt, profile.updatedAt],
          );
          await client.query(
            "UPDATE minutka_private.participants SET status = 'profile_completed', updated_at = $2 WHERE employee_id = $1",
            [profile.employeeId, completedAt],
          );
          return { profile, wasCompleted: participant.rows[0].status === "profile_completed" };
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async getParticipant(employeeId) {
      try {
        const result = await pool.query<ParticipantRow>(
          "SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at FROM minutka_private.participants WHERE employee_id = $1",
          [employeeId],
        );
        return result.rows[0] ? toParticipant(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getParticipantByInviteCode(inviteCode) {
      try {
        const result = await pool.query<ParticipantRow>(
          "SELECT employee_id, status, privacy_explanation_shown_at, created_at, updated_at FROM minutka_private.participants WHERE invite_code_digest = $1",
          [keyedDigest(inviteCode, inviteCodePepper)],
        );
        return result.rows[0] ? toParticipant(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getConsent(employeeId) {
      try {
        const result = await pool.query<ConsentRow>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [employeeId]);
        return result.rows[0] ? toConsent(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getProfile(employeeId) {
      try {
        const result = await pool.query<ProfileRow>("SELECT * FROM minutka_private.profiles WHERE employee_id = $1", [employeeId]);
        return result.rows[0] ? toProfile(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async deleteEmployeePersonalData(employeeId) {
      try {
        await withTransaction(pool, async (client) => {
          // Remove all employee-linked records first. The retained marker is
          // deliberately anonymous: it proves a deletion occurred without
          // retaining an identity or any personal content.
          await client.query("DELETE FROM minutka_audit.events WHERE employee_id = $1", [employeeId]);
          await client.query("DELETE FROM minutka_private.participants WHERE employee_id = $1", [employeeId]);
          await client.query(
            `INSERT INTO minutka_audit.events(event_id, request_id, event_type, metadata, occurred_at)
             VALUES ($1, $2, 'employee_data_deleted', '{}'::jsonb, $3)`,
            [randomUUID(), randomUUID(), clock.now()],
          );
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
