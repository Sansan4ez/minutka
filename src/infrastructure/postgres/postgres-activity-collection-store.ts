import type { Pool } from "pg";
import type { ActivityCollectionStore } from "../../application/activity-collection.js";
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
