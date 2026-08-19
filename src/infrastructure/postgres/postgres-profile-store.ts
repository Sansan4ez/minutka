import { randomUUID } from "node:crypto";
import type { Consent, Participant, UserProfile } from "../../domain/employee.js";
import { systemClock, type Clock } from "../../application/runtime-primitives.js";
import type { EmployeePersonalDataDeletionCounts, ProfileStore } from "../../application/profile-store.js";
import { PersistenceError, mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";
import type { ResearchSubject } from "../../application/research-identity-projection.js";
import { keyedDigest } from "./digests.js";
import { withTransaction } from "./postgres-pool.js";
import { applyPersonalContextPatch } from "../../application/personal-context-review.js";

type ParticipantRow = {
  employee_id: string;
  company_id: string;
  group_id: string;
  subject_key: string;
  role_id: string | null;
  status: Participant["status"];
  last_touch_on: string | Date | null;
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
type ResearchSubjectRow = {
  company_id: string;
  group_id: string;
  subject_key: string;
  role_id: string | null;
  message_ids: string[];
};
type ProfileRow = {
  employee_id: string;
  company_id: string;
  group_id: string;
  role_id: string;
  preferred_name: string;
  assistant_name: string;
  address_form: UserProfile["addressForm"];
  timezone: string;
  role: string | null;
  typical_tasks: string[] | null;
  persona: UserProfile["persona"];
  ai_level: UserProfile["aiLevel"] | null;
  program_goal: string | null;
  response_length: UserProfile["responseLength"];
  preferred_checkins_per_day: 1 | 2 | 3 | null;
  created_at: Date;
  updated_at: Date;
};

const participantColumns = "employee_id, company_id, group_id, subject_key, role_id, status, last_touch_on, privacy_explanation_shown_at, created_at, updated_at";
const researchSubjectSelect = `SELECT participant.company_id, participant.group_id, participant.subject_key, participant.role_id,
  COALESCE(array_agg(message.message_id ORDER BY message.created_at, message.message_id)
    FILTER (WHERE message.message_id IS NOT NULL), ARRAY[]::text[]) AS message_ids
  FROM minutka_private.participants participant
  LEFT JOIN minutka_private.messages message ON message.subject_key = participant.subject_key`;
const profileColumns = `p.employee_id, participant.company_id, participant.group_id, p.role_id,
  p.preferred_name, p.assistant_name, p.address_form, p.timezone, p.role, p.typical_tasks,
  p.persona, p.ai_level, p.program_goal, p.response_length, p.preferred_checkins_per_day, p.created_at, p.updated_at`;

const calendarDate = (value: string | Date): string => {
  if (typeof value === "string") return value.slice(0, 10);
  // PostgreSQL DATE values are parsed as local-midnight Date objects by `pg`.
  // Formatting through UTC shifts the day west of UTC, so preserve local parts.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};
const toParticipant = (row: ParticipantRow): Participant => ({
  employeeId: row.employee_id,
  companyId: row.company_id,
  groupId: row.group_id,
  subjectKey: row.subject_key,
  ...(row.role_id ? { roleId: row.role_id } : {}),
  status: row.status,
  ...(row.last_touch_on ? { lastTouchOn: calendarDate(row.last_touch_on) } : {}),
  ...(row.privacy_explanation_shown_at ? { privacyExplanationShownAt: row.privacy_explanation_shown_at.toISOString() } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const toResearchSubject = (row: ResearchSubjectRow): ResearchSubject => ({
  companyId: row.company_id,
  groupId: row.group_id,
  subjectKey: row.subject_key,
  ...(row.role_id ? { roleId: row.role_id } : {}),
  evidenceRefs: row.message_ids.map((id) => ({ kind: "message", id })),
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
  companyId: row.company_id,
  groupId: row.group_id,
  roleId: row.role_id,
  preferredName: row.preferred_name,
  assistantName: row.assistant_name,
  addressForm: row.address_form,
  persona: row.persona,
  responseLength: row.response_length,
  timezone: row.timezone,
  ...(row.role ? { role: row.role } : {}),
  ...(row.typical_tasks ? { typicalTasks: row.typical_tasks } : {}),
  ...(row.ai_level ? { aiLevel: row.ai_level } : {}),
  ...(row.program_goal ? { programGoal: row.program_goal } : {}),
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
    async issueInvite({ employeeId, inviteCode, companyId, groupId, issuedAt }) {
      const digest = keyedDigest(inviteCode, inviteCodePepper);
      try {
        return await withTransaction(pool, async (client) => {
          // Conditional insert avoids the missing-row SELECT FOR UPDATE race.
          const inserted = await client.query<ParticipantRow>(
            `INSERT INTO minutka_private.participants(employee_id, invite_code_digest, company_id, group_id, subject_key, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, gen_random_uuid(), 'invite_issued', $5, $5)
             ON CONFLICT DO NOTHING
             RETURNING ${participantColumns}`,
            [employeeId, digest, companyId, groupId, issuedAt],
          );
          if (inserted.rowCount) {
            return { participant: toParticipant(inserted.rows[0]), created: true, inviteMatches: true };
          }
          const [existingByInvite, existingByEmployee] = await Promise.all([
            client.query<ParticipantRow>(
              `SELECT ${participantColumns}
               FROM minutka_private.participants WHERE invite_code_digest = $1`,
              [digest],
            ),
            client.query<ParticipantRow>(
              `SELECT ${participantColumns}
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
             RETURNING ${participantColumns}`,
            [digest, openedAt, explanationShownAt ?? null],
          );
          if (updated.rowCount) return { participant: toParticipant(updated.rows[0]), opened: true };
          const existing = await client.query<ParticipantRow>(
            `SELECT ${participantColumns}
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
          const saved = await client.query<ConsentRow>(
            `INSERT INTO minutka_private.consents(employee_id, privacy_version, accepted_at, explanation_shown_at, source)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (employee_id) DO UPDATE SET
               privacy_version = EXCLUDED.privacy_version,
               accepted_at = EXCLUDED.accepted_at,
               explanation_shown_at = EXCLUDED.explanation_shown_at,
               source = EXCLUDED.source
             WHERE minutka_private.consents.privacy_version IS DISTINCT FROM EXCLUDED.privacy_version
             RETURNING *`,
            [consent.employeeId, consent.privacyVersion, consent.acceptedAt, consent.explanationShownAt, consent.source],
          );
          const row = saved.rows[0] ?? (
            await client.query<ConsentRow>("SELECT * FROM minutka_private.consents WHERE employee_id = $1", [consent.employeeId])
          ).rows[0];
          if (!row) throw new PersistenceError("participant_not_found");
          if (saved.rowCount) {
            const participant = await client.query(
              `UPDATE minutka_private.participants
               SET status = CASE WHEN status = 'profile_completed' THEN status ELSE 'consent_accepted' END, updated_at = $2
               WHERE employee_id = $1`,
              [consent.employeeId, consent.acceptedAt],
            );
            if (participant.rowCount !== 1) throw new PersistenceError("participant_not_found");
          }
          return { consent: toConsent(row), created: Boolean(saved.rowCount) };
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
    async completeProfile({ profile, completedAt, allowUpdate = true, deleteOnboardingDraft = false }) {
      try {
        return await withTransaction(pool, async (client) => {
          const participant = await client.query<{ status: Participant["status"] }>(
            "SELECT status FROM minutka_private.participants WHERE employee_id = $1 FOR UPDATE",
            [profile.employeeId],
          );
          if (!participant.rowCount) throw new PersistenceError("participant_not_found");
          const wasCompleted = participant.rows[0].status === "profile_completed";
          if (wasCompleted && !allowUpdate) {
            const existing = await client.query<ProfileRow>(
              `SELECT ${profileColumns}
               FROM minutka_private.profiles p
               JOIN minutka_private.participants participant USING (employee_id)
               WHERE p.employee_id = $1`,
              [profile.employeeId],
            );
            if (!existing.rows[0]) throw new PersistenceError("persistence_conflict");
            if (deleteOnboardingDraft) await client.query("DELETE FROM minutka_private.onboarding_drafts WHERE employee_id = $1", [profile.employeeId]);
            return { profile: toProfile(existing.rows[0]), wasCompleted: true };
          }
          await client.query(
            "UPDATE minutka_private.participants SET role_id = $2 WHERE employee_id = $1",
            [profile.employeeId, profile.roleId],
          );
          await client.query(
            `INSERT INTO minutka_private.profiles(employee_id, role_id, preferred_name, assistant_name, address_form, timezone, role, typical_tasks, persona, ai_level, program_goal, response_length, preferred_checkins_per_day, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (employee_id) DO UPDATE SET
               role_id=EXCLUDED.role_id, preferred_name=EXCLUDED.preferred_name, assistant_name=EXCLUDED.assistant_name,
               address_form=EXCLUDED.address_form, timezone=EXCLUDED.timezone,
               role=EXCLUDED.role, typical_tasks=EXCLUDED.typical_tasks, persona=EXCLUDED.persona,
               ai_level=EXCLUDED.ai_level, program_goal=EXCLUDED.program_goal, response_length=EXCLUDED.response_length,
               preferred_checkins_per_day=EXCLUDED.preferred_checkins_per_day, updated_at=EXCLUDED.updated_at`,
            [profile.employeeId, profile.roleId, profile.preferredName, profile.assistantName, profile.addressForm, profile.timezone,
              profile.role ?? null, profile.typicalTasks ? JSON.stringify(profile.typicalTasks) : null, profile.persona,
              profile.aiLevel ?? null, profile.programGoal ?? null, profile.responseLength, profile.preferredCheckinsPerDay ?? null, profile.createdAt, profile.updatedAt],
          );
          await client.query(
            "UPDATE minutka_private.participants SET status = 'profile_completed', updated_at = $2 WHERE employee_id = $1",
            [profile.employeeId, completedAt],
          );
          if (deleteOnboardingDraft) await client.query("DELETE FROM minutka_private.onboarding_drafts WHERE employee_id = $1", [profile.employeeId]);
          return { profile, wasCompleted };
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async updatePersonalContext({ employeeId, patch, updatedAt, replaceTypicalTasks }) {
      try {
        return await withTransaction(pool, async (client) => {
          const current = await client.query<ProfileRow>(
            `SELECT ${profileColumns}
             FROM minutka_private.profiles p
             JOIN minutka_private.participants participant USING (employee_id)
             WHERE p.employee_id = $1
             FOR UPDATE OF p`,
            [employeeId],
          );
          if (!current.rows[0]) throw new PersistenceError("profile_not_found");
          const result = applyPersonalContextPatch(toProfile(current.rows[0]), patch, updatedAt, { replaceTypicalTasks });
          if (result.changedFields.length === 0) return result;
          await client.query(
            `UPDATE minutka_private.profiles
             SET preferred_name = $2, persona = $3, response_length = $4, timezone = $5, role = $6,
                 typical_tasks = $7::jsonb, ai_level = $8, program_goal = $9, updated_at = $10
             WHERE employee_id = $1`,
            [employeeId, result.profile.preferredName, result.profile.persona, result.profile.responseLength,
              result.profile.timezone, result.profile.role ?? null,
              result.profile.typicalTasks ? JSON.stringify(result.profile.typicalTasks) : null,
              result.profile.aiLevel ?? null, result.profile.programGoal ?? null, updatedAt],
          );
          return result;
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async getParticipant(employeeId) {
      try {
        const result = await pool.query<ParticipantRow>(
          `SELECT ${participantColumns} FROM minutka_private.participants WHERE employee_id = $1`,
          [employeeId],
        );
        return result.rows[0] ? toParticipant(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async recordParticipantTouch({ employeeId, touchedOn }) {
      try {
        const result = await pool.query(
          `UPDATE minutka_private.participants
           SET last_touch_on = GREATEST(COALESCE(last_touch_on, $2::date), $2::date)
           WHERE employee_id = $1`,
          [employeeId, touchedOn],
        );
        if (result.rowCount !== 1) throw new PersistenceError("participant_not_found");
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw mapPostgresError(error);
      }
    },
    async listResearchSubjects({ companyId, groupId }) {
      try {
        const result = await pool.query<ResearchSubjectRow>(
          `${researchSubjectSelect}
           WHERE participant.company_id = $1 AND participant.group_id = $2
           GROUP BY participant.company_id, participant.group_id, participant.subject_key, participant.role_id
           ORDER BY participant.subject_key ASC`,
          [companyId, groupId],
        );
        return result.rows.map(toResearchSubject);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getResearchSubject({ companyId, groupId, subjectKey }) {
      try {
        const result = await pool.query<ResearchSubjectRow>(
          `${researchSubjectSelect}
           WHERE participant.company_id = $1 AND participant.group_id = $2 AND participant.subject_key = $3
           GROUP BY participant.company_id, participant.group_id, participant.subject_key, participant.role_id`,
          [companyId, groupId, subjectKey],
        );
        return result.rows[0] ? toResearchSubject(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async listParticipants({ companyId, groupId, limit, after }) {
      try {
        const result = await pool.query<ParticipantRow>(
          `SELECT ${participantColumns}
           FROM minutka_private.participants
           WHERE company_id = $1 AND group_id = $2
             AND ($4::timestamptz IS NULL OR (created_at, employee_id) > ($4::timestamptz, $5::text))
           ORDER BY created_at ASC, employee_id ASC
           LIMIT $3`,
          [companyId, groupId, limit, after?.createdAt ?? null, after?.employeeId ?? null],
        );
        return result.rows.map(toParticipant);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getParticipantByInviteCode(inviteCode) {
      try {
        const result = await pool.query<ParticipantRow>(
          `SELECT ${participantColumns} FROM minutka_private.participants WHERE invite_code_digest = $1`,
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
        const result = await pool.query<ProfileRow>(
          `SELECT ${profileColumns}
           FROM minutka_private.profiles p
           JOIN minutka_private.participants participant USING (employee_id)
           WHERE p.employee_id = $1`,
          [employeeId],
        );
        return result.rows[0] ? toProfile(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async deleteEmployeePersonalData(employeeId) {
      try {
        return await withTransaction(pool, async (client) => {
          const count = async (table: string, ownerColumn: "employee_id" | "user_id" | "owner_id") => Number((
            await client.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE ${ownerColumn} = $1`, [employeeId])
          ).rows[0]!.count);
          const counts: EmployeePersonalDataDeletionCounts = {
            participants: await count("minutka_private.participants", "employee_id"),
            profiles: await count("minutka_private.profiles", "employee_id"),
            consents: await count("minutka_private.consents", "employee_id"),
            conversations: await count("minutka_private.threads", "employee_id"),
            threadSummaries: await count("minutka_private.thread_summaries", "employee_id"),
            messages: await count("minutka_private.messages", "employee_id"),
            activities: await count("minutka_private.activities", "employee_id"),
            insights: await count("minutka_private.insights", "employee_id"),
            feedback: await count("minutka_private.feedback", "employee_id"),
            schedules: await count("minutka_private.process_schedules", "user_id"),
            scheduleFires: await count("minutka_private.schedule_fires", "user_id"),
            telegramSessions: await count("minutka_private.telegram_sessions", "employee_id"),
            telegramActionMessages: await count("minutka_private.telegram_action_messages", "employee_id"),
            onboardingDrafts: await count("minutka_private.onboarding_drafts", "employee_id"),
            pendingActionGroups: await count("minutka_private.telegram_pending_action_groups", "owner_id"),
            ideas: await count("minutka_private.ideas", "user_id"),
            ideaDeletionConfirmations: await count("minutka_private.idea_deletion_confirmations", "user_id"),
            tasks: await count("minutka_private.tasks", "user_id"),
            taskMutationConfirmations: await count("minutka_private.task_mutation_confirmations", "user_id"),
            contextDocumentConfirmations: await count("minutka_private.context_document_confirmations", "user_id"),
            artifacts: await count("minutka_private.artifacts", "user_id"),
            artifactContents: await count("minutka_private.artifact_contents", "user_id"),
            auditEvents: await count("minutka_audit.events", "employee_id"),
            // Usage rows are personal records and are deleted with the participant.
            // No separate cross-user aggregate usage table exists in the pilot.
            usageRecords: await count("minutka_private.usage", "user_id"),
          };
          // Remove all employee-linked records first. The retained marker is
          // deliberately anonymous: it proves a deletion occurred without
          // retaining an identity or any personal content. The consent row is
          // deleted with the participant; only this anonymous withdrawal marker remains.
          await client.query("DELETE FROM minutka_audit.events WHERE employee_id = $1", [employeeId]);
          await client.query("DELETE FROM minutka_private.participants WHERE employee_id = $1", [employeeId]);
          await client.query(
            `INSERT INTO minutka_audit.events(event_id, request_id, event_type, metadata, occurred_at)
             VALUES ($1, $2, 'employee_data_deleted', '{}'::jsonb, $3)`,
            [randomUUID(), randomUUID(), clock.now()],
          );
          return counts;
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
