import type { Pool } from "pg";
import type { ActivityCollectionStore } from "../../application/activity-collection.js";
import { mapPostgresError, PersistenceOutcomeUnknownError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresActivityCollectionStore(pool: Pool): ActivityCollectionStore {
  return {
    async saveActivityPair({ personal, anonymized }) {
      try {
        await withTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO minutka_private.activities
              (activity_id, employee_id, company_id, group_id, role_id, task_category,
               obstacle_kind, obstacle_value, duration_bucket, system, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              personal.activityId,
              personal.employeeId,
              personal.companyId,
              personal.groupId,
              personal.roleId,
              personal.taskCategory ?? null,
              personal.obstacle?.kind ?? null,
              personal.obstacle?.value ?? null,
              personal.durationBucket ?? null,
              personal.system ?? null,
              personal.recordedAt,
            ],
          );
          await client.query(
            `INSERT INTO minutka_reporting.anonymized_activities
              (company_id, group_id, role_id, task_category, obstacle_kind, obstacle_value,
               duration_bucket, system, activity_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              anonymized.companyId,
              anonymized.groupId,
              anonymized.roleId,
              anonymized.taskCategory ?? null,
              anonymized.obstacle?.kind ?? null,
              anonymized.obstacle?.value ?? null,
              anonymized.durationBucket ?? null,
              anonymized.system ?? null,
              anonymized.date,
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
