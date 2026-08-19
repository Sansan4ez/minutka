import type { Pool } from "pg";
import type { ActivityCollectionStore } from "../../application/activity-collection.js";
import type { OwnActivityFacet, OwnActivityReadStore } from "../../application/weekly-activity-summary.js";
import { mapPostgresError, PersistenceError, PersistenceOutcomeUnknownError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresActivityCollectionStore(pool: Pool): ActivityCollectionStore {
  return {
    async saveActivity(activity) {
      try {
        await withTransaction(pool, async (client) => {
          // The evidence link points at the message of the turn that is still
          // running, so it cannot be a foreign key. What the key was there for —
          // never linking one owner's activity to another owner's message — is
          // kept here: an already-stored message under a different owner or
          // subject rejects the write instead of silently crossing the boundary.
          const inserted = await client.query(
            `INSERT INTO minutka_private.activities
              (activity_id, employee_id, subject_key, source_message_id, company_id, group_id, role_id,
               task_category, obstacle_kind, obstacle_value, duration_bucket, system, activity_date, recorded_at)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
             WHERE NOT EXISTS (
               SELECT 1 FROM minutka_private.messages message
               WHERE message.message_id = $4
                 AND (message.employee_id <> $2
                   OR (message.subject_key IS NOT NULL AND message.subject_key <> $3::uuid))
             )`,
            [
              activity.activityId,
              activity.employeeId,
              activity.subjectKey,
              activity.sourceMessageId ?? null,
              activity.companyId,
              activity.groupId,
              activity.roleId,
              activity.taskCategory ?? null,
              activity.obstacle?.kind ?? null,
              activity.obstacle?.value ?? null,
              activity.durationBucket ?? null,
              activity.system ?? null,
              activity.activityDate,
              activity.recordedAt,
            ],
          );
          if (inserted.rowCount === 0) throw new PersistenceError("persistence_conflict");
        });
      } catch (error) {
        if (error instanceof PersistenceOutcomeUnknownError) throw error;
        throw mapPostgresError(error);
      }
    },
  };
}

type OwnActivityRow = {
  employee_id: string;
  task_category: OwnActivityFacet["taskCategory"] | null;
  obstacle_kind: NonNullable<OwnActivityFacet["obstacle"]>["kind"] | null;
  obstacle_value: string | null;
  duration_bucket: OwnActivityFacet["durationBucket"] | null;
  system: OwnActivityFacet["system"] | null;
  activity_date: string;
};

/** Owner-scoped window read behind the weekly personal summary. */
export function createPostgresOwnActivityReadStore(pool: Pool): OwnActivityReadStore {
  return {
    async listOwnActivities({ employeeId, fromDate, toDate }) {
      try {
        const result = await pool.query<OwnActivityRow>(
          `SELECT employee_id, task_category, obstacle_kind, obstacle_value, duration_bucket, system,
                  activity_date::text AS activity_date
           FROM minutka_private.activities
           WHERE employee_id = $1 AND activity_date BETWEEN $2::date AND $3::date
           ORDER BY activity_date, recorded_at, activity_id`,
          [employeeId, fromDate, toDate],
        );
        return result.rows.map((row): OwnActivityFacet => ({
          employeeId: row.employee_id,
          ...(row.task_category ? { taskCategory: row.task_category } : {}),
          ...(row.obstacle_kind && row.obstacle_value
            ? { obstacle: { kind: row.obstacle_kind, value: row.obstacle_value } as OwnActivityFacet["obstacle"] }
            : {}),
          ...(row.duration_bucket ? { durationBucket: row.duration_bucket } : {}),
          ...(row.system ? { system: row.system } : {}),
          activityDate: row.activity_date,
        }));
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
