import type { Pool } from "pg";
import type { AnonymizedActivityRecord } from "../../application/activity-collection.js";
import type { CompanyReportStore } from "../../application/company-reporting.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

type ParticipantCountRow = { participant_count: string };
type RoleCountRow = { role_id: string; participant_count: string };
type ActivityRow = {
  company_id: string;
  group_id: string;
  role_id: string;
  kind: AnonymizedActivityRecord["kind"] | null;
  value: AnonymizedActivityRecord["value"] | null;
  duration_bucket: AnonymizedActivityRecord["durationBucket"] | null;
  system: AnonymizedActivityRecord["system"] | null;
  activity_date: string | Date;
};

export function createPostgresCompanyReportStore(pool: Pool): CompanyReportStore {
  return {
    async loadGroupSnapshot({ companyId, groupId }) {
      try {
        return await withTransaction(pool, async (client) => {
          const participantResult = await client.query<ParticipantCountRow>(
            `SELECT count(*)::text AS participant_count
             FROM minutka_private.participants
             WHERE company_id = $1 AND group_id = $2`,
            [companyId, groupId],
          );
          const roleResult = await client.query<RoleCountRow>(
            `SELECT role_id, count(*)::text AS participant_count
             FROM minutka_private.participants
             WHERE company_id = $1 AND group_id = $2 AND role_id IS NOT NULL
             GROUP BY role_id`,
            [companyId, groupId],
          );
          const activityResult = await client.query<ActivityRow>(
            `SELECT company_id, group_id, role_id, kind, value, duration_bucket, system, activity_date
             FROM minutka_reporting.anonymized_activities
             WHERE company_id = $1 AND group_id = $2`,
            [companyId, groupId],
          );
          return {
            participantCounts: {
              group: Number(participantResult.rows[0]?.participant_count ?? 0),
              byRole: new Map(roleResult.rows.map((row) => [row.role_id, Number(row.participant_count)])),
            },
            anonymizedActivities: activityResult.rows.map(toActivity),
          };
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}

function toActivity(row: ActivityRow): AnonymizedActivityRecord {
  return {
    companyId: row.company_id,
    groupId: row.group_id,
    roleId: row.role_id,
    ...(row.kind === null ? {} : { kind: row.kind }),
    ...(row.value === null ? {} : { value: row.value }),
    ...(row.duration_bucket === null ? {} : { durationBucket: row.duration_bucket }),
    ...(row.system === null ? {} : { system: row.system }),
    date: row.activity_date instanceof Date
      ? row.activity_date.toISOString().slice(0, 10)
      : row.activity_date.slice(0, 10),
  };
}
