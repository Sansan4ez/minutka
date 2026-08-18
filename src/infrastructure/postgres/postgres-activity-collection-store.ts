import type { Pool } from "pg";
import type { ActivityCollectionStore } from "../../application/activity-collection.js";
import { mapPostgresError, PersistenceOutcomeUnknownError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresActivityCollectionStore(pool: Pool): ActivityCollectionStore {
  return {
    async saveActivity(activity) {
      try {
        await withTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO minutka_private.activities
              (activity_id, employee_id, subject_key, source_message_id, company_id, group_id, role_id,
               task_category, obstacle_kind, obstacle_value, duration_bucket, system, activity_date, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
        });
      } catch (error) {
        if (error instanceof PersistenceOutcomeUnknownError) throw error;
        throw mapPostgresError(error);
      }
    },
  };
}
