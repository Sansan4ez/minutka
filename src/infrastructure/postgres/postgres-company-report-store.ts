import type { Pool } from "pg";
import type { PersonalActivityRecord } from "../../application/activity-collection.js";
import type { CompanyReportStore } from "../../application/company-reporting.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

type ParticipantRow = { subject_key: string; role_id: string | null };
type ParticipantCountRow = { participant_count: string };
type ActivityRow = {
  activity_id: string;
  subject_key: string;
  company_id: string;
  group_id: string;
  role_id: string;
  task_category: PersonalActivityRecord["taskCategory"] | null;
  routine_pattern: PersonalActivityRecord["routinePattern"] | null;
  automation_candidate: PersonalActivityRecord["automationCandidate"] | null;
  energy_stress_marker: PersonalActivityRecord["energyStressMarker"] | null;
  duration_bucket: PersonalActivityRecord["durationBucket"] | null;
  system: PersonalActivityRecord["system"] | null;
  activity_date: string;
  recorded_at: Date;
};

/** Reads only canonical participant/activity state; the legacy reporting table is intentionally unused. */
export function createPostgresCompanyReportStore(pool: Pool): CompanyReportStore {
  return {
    async loadGroupSnapshot({ companyId, groupId }) {
      try {
        return await withTransaction(pool, async (client) => {
          const [countResult, subjectResult, activityResult] = await Promise.all([
            client.query<ParticipantCountRow>(
              `SELECT count(*)::text AS participant_count
               FROM minutka_private.participants
               WHERE company_id=$1 AND group_id=$2`,
              [companyId, groupId],
            ),
            client.query<ParticipantRow>(
              `SELECT subject_key::text AS subject_key, role_id
               FROM minutka_private.participants
               WHERE company_id=$1 AND group_id=$2
               ORDER BY subject_key`,
              [companyId, groupId],
            ),
            client.query<ActivityRow>(
              `SELECT activity_id, subject_key::text AS subject_key, company_id, group_id, role_id,
                      task_category, routine_pattern, automation_candidate, energy_stress_marker,
                      duration_bucket, system, activity_date::text AS activity_date, recorded_at
               FROM minutka_private.activities
               WHERE company_id=$1 AND group_id=$2
               ORDER BY recorded_at, activity_id`,
              [companyId, groupId],
            ),
          ]);
          return {
            invitedParticipants: Number(countResult.rows[0]?.participant_count ?? 0),
            subjects: subjectResult.rows.map((row) => ({ subjectKey: row.subject_key, ...(row.role_id ? { roleId: row.role_id } : {}) })),
            activities: activityResult.rows.map(toActivity),
          };
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}

function toActivity(row: ActivityRow): Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId"> {
  return {
    activityId: row.activity_id,
    subjectKey: row.subject_key,
    companyId: row.company_id,
    groupId: row.group_id,
    roleId: row.role_id,
    ...(row.task_category === null ? {} : { taskCategory: row.task_category }),
    ...(row.routine_pattern === null ? {} : { routinePattern: row.routine_pattern }),
    ...(row.automation_candidate === null ? {} : { automationCandidate: row.automation_candidate }),
    ...(row.energy_stress_marker === null ? {} : { energyStressMarker: row.energy_stress_marker }),
    ...(row.duration_bucket === null ? {} : { durationBucket: row.duration_bucket }),
    ...(row.system === null ? {} : { system: row.system }),
    activityDate: row.activity_date,
    recordedAt: row.recorded_at.toISOString(),
  };
}
