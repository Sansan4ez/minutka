import type { Pool } from "pg";
import type { ActivityCollectionStore } from "../../application/activity-collection.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresActivityCollectionStore(pool: Pool): ActivityCollectionStore {
  return {
    async saveActivityPair({ personal, anonymized }) {
      try {
        await withTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO minutka_private.activities
              (activity_id, employee_id, company_id, group_id, role_id, kind, value,
               duration_bucket, system, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              personal.activityId,
              personal.employeeId,
              personal.companyId,
              personal.groupId,
              personal.roleId,
              personal.kind ?? null,
              personal.value ?? null,
              personal.durationBucket ?? null,
              personal.system ?? null,
              personal.recordedAt,
            ],
          );
          await client.query(
            `INSERT INTO minutka_reporting.anonymized_activities
              (company_id, group_id, role_id, kind, value, duration_bucket, system, activity_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              anonymized.companyId,
              anonymized.groupId,
              anonymized.roleId,
              anonymized.kind ?? null,
              anonymized.value ?? null,
              anonymized.durationBucket ?? null,
              anonymized.system ?? null,
              anonymized.date,
            ],
          );
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
