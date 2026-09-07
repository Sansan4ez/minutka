import type { Pool, PoolClient } from "pg";
import type { ActivityCollectionStore, PersonalActivityRecord } from "../../application/activity-collection.js";
import type {
  ActivityCorrectionCommand,
  ActivityMutationStore,
  ActivityRevisionOperation,
  ActivityRevisionRecord,
  ActivityStatus,
  ActivitySupersessionCommand,
} from "../../application/activity-correction.js";
import type { OwnActivityFacet, OwnActivityReadStore } from "../../application/own-activity-window.js";
import type { RecentOwnActivityReadStore } from "../../application/recent-own-activities.js";
import { mapPostgresError, PersistenceError, PersistenceOutcomeUnknownError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";
import { canonicalActivityRevisionChangedAtSql } from "./postgres-activity-revision-projection.js";

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
               task_category, routine_pattern, automation_candidate, energy_stress_marker,
               duration_bucket, system, routine_id, routine_label, recurrence, activity_date,
               recorded_at, revision, status, updated_at)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,'active',$18
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
              activity.routinePattern ?? null,
              activity.automationCandidate ?? null,
              activity.energyStressMarker ?? null,
              activity.durationBucket ?? null,
              activity.system ?? null,
              activity.routineId ?? null,
              activity.routineLabel ?? null,
              activity.recurrence ?? null,
              activity.activityDate,
              activity.recordedAt,
            ],
          );
          if (inserted.rowCount === 0) throw new PersistenceError("persistence_conflict");
          await insertRevision(client, {
            ...activity,
            revision: 1,
            status: "active",
            operation: "created",
            changedAt: activity.recordedAt,
          });
        });
      } catch (error) {
        if (error instanceof PersistenceOutcomeUnknownError) throw error;
        throw mapPostgresError(error);
      }
    },
    async getActivityById(activityId) {
      try {
        const result = await pool.query<ActivityRow>(`${activitySelect} WHERE activity.activity_id = $1`, [activityId]);
        const row = result.rows[0];
        return row ? personalActivity(row) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}

export function createPostgresActivityMutationStore(pool: Pool): ActivityMutationStore {
  return {
    async correctRecentActivity(command) {
      try {
        return await withTransaction(pool, async (client) => {
          await assertSourceMessageOwner(client, command.sourceMessageId, command.employeeId);
          const row = await loadRecentForUpdate(client, command, command.handle);
          if (!row) throw new PersistenceError("persistence_conflict");
          const current = personalActivityWithoutRevisions(row);
          const corrected = command.mode === "patch" ? { ...current } : clearFacets(current);
          applyCommandFacets(corrected, command);
          if (isCorrectionReplay(row, command, corrected)) return current;
          requireActiveRevision(row, command.expectedRevision);
          const revision = command.expectedRevision + 1;
          const result = await client.query<ActivityRow>(
            `UPDATE minutka_private.activities activity SET
               task_category=$1, routine_pattern=$2, automation_candidate=$3, energy_stress_marker=$4,
               duration_bucket=$5, system=$6, revision=$7, last_correction_message_id=$8, updated_at=$9
             WHERE activity.activity_id=$10 AND activity.employee_id=$11 AND activity.company_id=$12 AND activity.group_id=$13
               AND activity.recorded_at >= $14::timestamptz AND activity.recorded_at <= $15::timestamptz
               AND activity.status='active' AND activity.revision=$16
             RETURNING ${activityReturning}`,
            [corrected.taskCategory ?? null, corrected.routinePattern ?? null, corrected.automationCandidate ?? null,
              corrected.energyStressMarker ?? null, corrected.durationBucket ?? null, corrected.system ?? null,
              revision, command.sourceMessageId, command.changedAt, command.handle, command.employeeId,
              command.companyId, command.groupId, command.recordedAfter, command.recordedBefore, command.expectedRevision],
          );
          const updated = result.rows[0];
          if (!updated) throw new PersistenceError("persistence_conflict");
          await insertRevision(client, {
            ...personalActivityWithoutRevisions(updated),
            revision,
            status: "active",
            operation: "corrected",
            sourceMessageId: command.sourceMessageId,
            changedAt: command.changedAt,
          });
          return personalActivityWithoutRevisions(updated);
        });
      } catch (error) {
        if (error instanceof PersistenceOutcomeUnknownError) throw error;
        throw mapPostgresError(error);
      }
    },
    async supersedeRecentActivity(command) {
      try {
        return await withTransaction(pool, async (client) => {
          await assertSourceMessageOwner(client, command.sourceMessageId, command.employeeId);
          const handles = [command.handle, command.replacementHandle].sort();
          const locked = await client.query<ActivityRow>(
            `SELECT ${activityColumns}
             FROM minutka_private.activities activity
             WHERE activity.activity_id = ANY($1::text[])
               AND activity.employee_id=$2 AND activity.company_id=$3 AND activity.group_id=$4
               AND activity.recorded_at >= $5::timestamptz AND activity.recorded_at <= $6::timestamptz
             ORDER BY activity.activity_id
             FOR UPDATE OF activity`,
            [handles, command.employeeId, command.companyId, command.groupId, command.recordedAfter, command.recordedBefore],
          );
          const target = locked.rows.find((row) => row.activity_id === command.handle);
          const replacement = locked.rows.find((row) => row.activity_id === command.replacementHandle);
          if (!target) throw new PersistenceError("persistence_conflict");
          if (isSupersessionReplay(target, command)) return personalActivityWithoutRevisions(target);
          if (!replacement) throw new PersistenceError("persistence_conflict");
          requireActiveRevision(target, command.expectedRevision);
          requireActiveRevision(replacement, command.replacementExpectedRevision);
          const revision = command.expectedRevision + 1;
          const result = await client.query<ActivityRow>(
            `UPDATE minutka_private.activities activity SET
               status='superseded', superseded_by_activity_id=$1, revision=$2,
               last_correction_message_id=$3, updated_at=$4
             WHERE activity.activity_id=$5 AND activity.employee_id=$6 AND activity.company_id=$7 AND activity.group_id=$8
               AND activity.status='active' AND activity.revision=$9
             RETURNING ${activityReturning}`,
            [command.replacementHandle, revision, command.sourceMessageId, command.changedAt,
              command.handle, command.employeeId, command.companyId, command.groupId, command.expectedRevision],
          );
          const updated = result.rows[0];
          if (!updated) throw new PersistenceError("persistence_conflict");
          await insertRevision(client, {
            ...personalActivityWithoutRevisions(updated),
            revision,
            status: "superseded",
            operation: "superseded",
            sourceMessageId: command.sourceMessageId,
            supersededByActivityId: command.replacementHandle,
            changedAt: command.changedAt,
          });
          return personalActivityWithoutRevisions(updated);
        });
      } catch (error) {
        if (error instanceof PersistenceOutcomeUnknownError) throw error;
        throw mapPostgresError(error);
      }
    },
  };
}

type ActivityRow = {
  activity_id: string;
  employee_id: string;
  subject_key: string;
  source_message_id: string | null;
  company_id: string;
  group_id: string;
  role_id: string;
  task_category: OwnActivityFacet["taskCategory"] | null;
  routine_pattern: OwnActivityFacet["routinePattern"] | null;
  automation_candidate: OwnActivityFacet["automationCandidate"] | null;
  energy_stress_marker: OwnActivityFacet["energyStressMarker"] | null;
  duration_bucket: OwnActivityFacet["durationBucket"] | null;
  system: OwnActivityFacet["system"] | null;
  routine_id: PersonalActivityRecord["routineId"] | null;
  routine_label: PersonalActivityRecord["routineLabel"] | null;
  recurrence: PersonalActivityRecord["recurrence"] | null;
  activity_date: string;
  recorded_at: Date;
  revision: number;
  status: ActivityStatus;
  superseded_by_activity_id: string | null;
  last_correction_message_id: string | null;
  updated_at: Date;
  revisions?: ActivityRevisionRecord[] | null;
};

const activityColumns = `activity.activity_id, activity.employee_id, activity.subject_key, activity.source_message_id,
  activity.company_id, activity.group_id, activity.role_id, activity.task_category, activity.routine_pattern,
  activity.automation_candidate, activity.energy_stress_marker, activity.duration_bucket, activity.system,
  activity.routine_id, activity.routine_label, activity.recurrence,
  activity.activity_date::text AS activity_date, activity.recorded_at, activity.revision, activity.status,
  activity.superseded_by_activity_id, activity.last_correction_message_id, activity.updated_at`;
const revisionProjection = `COALESCE((SELECT json_agg(json_strip_nulls(json_build_object(
  'revision', history.revision, 'operation', history.operation, 'sourceMessageId', history.source_message_id,
  'taskCategory', history.task_category, 'routinePattern', history.routine_pattern,
  'automationCandidate', history.automation_candidate, 'energyStressMarker', history.energy_stress_marker,
  'durationBucket', history.duration_bucket, 'system', history.system, 'routineId', history.routine_id,
  'routineLabel', history.routine_label, 'recurrence', history.recurrence, 'status', history.status,
  'supersededByActivityId', history.superseded_by_activity_id,
  'changedAt', ${canonicalActivityRevisionChangedAtSql})) ORDER BY history.revision)
  FROM minutka_private.activity_revisions history WHERE history.activity_id=activity.activity_id), '[]'::json) AS revisions`;
const activitySelect = `SELECT ${activityColumns}, ${revisionProjection} FROM minutka_private.activities activity`;
const activityReturning = `activity_id, employee_id, subject_key, source_message_id, company_id, group_id, role_id,
  task_category, routine_pattern, automation_candidate, energy_stress_marker, duration_bucket, system,
  routine_id, routine_label, recurrence, activity_date::text AS activity_date, recorded_at, revision, status, superseded_by_activity_id,
  last_correction_message_id, updated_at`;

function personalActivity(row: ActivityRow): PersonalActivityRecord {
  return {
    activityId: row.activity_id,
    employeeId: row.employee_id,
    subjectKey: row.subject_key,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    companyId: row.company_id,
    groupId: row.group_id,
    roleId: row.role_id,
    ...(row.task_category ? { taskCategory: row.task_category } : {}),
    ...(row.routine_pattern ? { routinePattern: row.routine_pattern } : {}),
    ...(row.automation_candidate ? { automationCandidate: row.automation_candidate } : {}),
    ...(row.energy_stress_marker ? { energyStressMarker: row.energy_stress_marker } : {}),
    ...(row.routine_id ? { routineId: row.routine_id } : {}),
    ...(row.routine_label ? { routineLabel: row.routine_label } : {}),
    ...(row.recurrence ? { recurrence: row.recurrence } : {}),
    activityDate: row.activity_date,
    recordedAt: row.recorded_at.toISOString(),
    revision: row.revision,
    status: row.status,
    ...(row.superseded_by_activity_id ? { supersededByActivityId: row.superseded_by_activity_id } : {}),
    ...(row.last_correction_message_id ? { lastCorrectionMessageId: row.last_correction_message_id } : {}),
    updatedAt: row.updated_at.toISOString(),
    ...(row.revisions ? { revisions: row.revisions } : {}),
    ...(row.duration_bucket ? { durationBucket: row.duration_bucket } : {}),
    ...(row.system ? { system: row.system } : {}),
  };
}

function personalActivityWithoutRevisions(row: ActivityRow): Omit<PersonalActivityRecord, "revisions"> {
  const activity = personalActivity(row);
  delete activity.revisions;
  return activity;
}

/** Owner-and-tenant-scoped recent read for explicit correction lookup only. */
export function createPostgresRecentOwnActivityReadStore(pool: Pool): RecentOwnActivityReadStore {
  return {
    async listRecentOwnActivities({ employeeId, companyId, groupId, recordedAfter, recordedBefore, limit }) {
      try {
        const result = await pool.query<ActivityRow>(
          `${activitySelect}
           WHERE activity.employee_id=$1 AND activity.company_id=$2 AND activity.group_id=$3
             AND activity.status='active'
             AND activity.recorded_at >= $4::timestamptz AND activity.recorded_at <= $5::timestamptz
           ORDER BY activity.recorded_at DESC, activity.activity_id DESC LIMIT $6`,
          [employeeId, companyId, groupId, recordedAfter, recordedBefore, limit],
        );
        return result.rows.map(personalActivity);
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

type OwnActivityRow = {
  employee_id: string;
  task_category: OwnActivityFacet["taskCategory"] | null;
  routine_pattern: OwnActivityFacet["routinePattern"] | null;
  automation_candidate: OwnActivityFacet["automationCandidate"] | null;
  energy_stress_marker: OwnActivityFacet["energyStressMarker"] | null;
  duration_bucket: OwnActivityFacet["durationBucket"] | null;
  system: OwnActivityFacet["system"] | null;
  routine_id: PersonalActivityRecord["routineId"] | null;
  routine_label: PersonalActivityRecord["routineLabel"] | null;
  recurrence: PersonalActivityRecord["recurrence"] | null;
  activity_date: string;
};

/** Owner-scoped window read behind weekly and cycle personal summaries. */
export function createPostgresOwnActivityReadStore(pool: Pool): OwnActivityReadStore {
  return {
    async listOwnActivities({ employeeId, fromDate, toDate }) {
      try {
        const result = await pool.query<OwnActivityRow>(
          `SELECT employee_id, task_category, routine_pattern, automation_candidate, energy_stress_marker,
                  duration_bucket, system, routine_id, routine_label, recurrence,
                  activity_date::text AS activity_date
           FROM minutka_private.activities
           WHERE employee_id=$1 AND status='active' AND activity_date BETWEEN $2::date AND $3::date
           ORDER BY activity_date, recorded_at, activity_id`,
          [employeeId, fromDate, toDate],
        );
        return result.rows.map((row): OwnActivityFacet => ({
          employeeId: row.employee_id,
          ...(row.task_category ? { taskCategory: row.task_category } : {}),
          ...(row.routine_pattern ? { routinePattern: row.routine_pattern } : {}),
          ...(row.automation_candidate ? { automationCandidate: row.automation_candidate } : {}),
          ...(row.energy_stress_marker ? { energyStressMarker: row.energy_stress_marker } : {}),
          ...(row.routine_id ? { routineId: row.routine_id } : {}),
          ...(row.routine_label ? { routineLabel: row.routine_label } : {}),
          ...(row.recurrence ? { recurrence: row.recurrence } : {}),
          ...(row.duration_bucket ? { durationBucket: row.duration_bucket } : {}),
          ...(row.system ? { system: row.system } : {}),
          activityDate: row.activity_date,
        }));
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

async function assertSourceMessageOwner(client: PoolClient, sourceMessageId: string, employeeId: string): Promise<void> {
  const result = await client.query<{ conflicts: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM minutka_private.messages WHERE message_id=$1 AND employee_id<>$2) AS conflicts`,
    [sourceMessageId, employeeId],
  );
  if (result.rows[0]?.conflicts) throw new PersistenceError("persistence_conflict");
}

async function loadRecentForUpdate(
  client: PoolClient,
  command: Pick<ActivityCorrectionCommand, "employeeId" | "companyId" | "groupId" | "recordedAfter" | "recordedBefore">,
  handle: string,
): Promise<ActivityRow | undefined> {
  const result = await client.query<ActivityRow>(
    `SELECT ${activityColumns}
     FROM minutka_private.activities activity
     WHERE activity.activity_id=$1 AND activity.employee_id=$2 AND activity.company_id=$3 AND activity.group_id=$4
       AND activity.recorded_at >= $5::timestamptz AND activity.recorded_at <= $6::timestamptz
     FOR UPDATE OF activity`,
    [handle, command.employeeId, command.companyId, command.groupId, command.recordedAfter, command.recordedBefore],
  );
  return result.rows[0];
}

async function insertRevision(
  client: PoolClient,
  input: PersonalActivityRecord & { operation: ActivityRevisionOperation; changedAt: string },
): Promise<void> {
  await client.query(
    `INSERT INTO minutka_private.activity_revisions
      (activity_id, revision, operation, source_message_id, task_category, routine_pattern,
       automation_candidate, energy_stress_marker, duration_bucket, system, routine_id,
       routine_label, recurrence, status, superseded_by_activity_id, changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [input.activityId, input.revision ?? 1, input.operation, input.sourceMessageId ?? null,
      input.taskCategory ?? null, input.routinePattern ?? null, input.automationCandidate ?? null,
      input.energyStressMarker ?? null, input.durationBucket ?? null, input.system ?? null,
      input.routineId ?? null, input.routineLabel ?? null, input.recurrence ?? null,
      input.status ?? "active", input.supersededByActivityId ?? null, input.changedAt],
  );
}

function requireActiveRevision(row: ActivityRow, expectedRevision: number): void {
  if (row.status !== "active" || row.revision !== expectedRevision) throw new PersistenceError("persistence_conflict");
}

function isCorrectionReplay(
  row: ActivityRow,
  command: ActivityCorrectionCommand,
  intended: PersonalActivityRecord,
): boolean {
  return row.last_correction_message_id === command.sourceMessageId
    && row.revision === command.expectedRevision + 1
    && row.status === "active"
    && sameFacets(personalActivityWithoutRevisions(row), intended);
}

function isSupersessionReplay(row: ActivityRow, command: ActivitySupersessionCommand): boolean {
  return row.last_correction_message_id === command.sourceMessageId
    && row.revision === command.expectedRevision + 1
    && row.status === "superseded"
    && row.superseded_by_activity_id === command.replacementHandle;
}

function clearFacets(activity: PersonalActivityRecord): PersonalActivityRecord {
  const result = { ...activity };
  delete result.taskCategory;
  delete result.routinePattern;
  delete result.automationCandidate;
  delete result.energyStressMarker;
  delete result.routineId;
  delete result.routineLabel;
  delete result.recurrence;
  delete result.durationBucket;
  delete result.system;
  return result;
}

function applyCommandFacets(target: PersonalActivityRecord, command: ActivityCorrectionCommand): void {
  if (command.taskCategory !== undefined) target.taskCategory = command.taskCategory;
  if (command.routinePattern !== undefined) target.routinePattern = command.routinePattern;
  if (command.automationCandidate !== undefined) target.automationCandidate = command.automationCandidate;
  if (command.energyStressMarker !== undefined) target.energyStressMarker = command.energyStressMarker;
  if (command.routineId !== undefined) target.routineId = command.routineId;
  if (command.routineLabel !== undefined) target.routineLabel = command.routineLabel;
  if (command.recurrence !== undefined) target.recurrence = command.recurrence;
  if (command.durationBucket !== undefined) target.durationBucket = command.durationBucket;
  if (command.system !== undefined) target.system = command.system;
}

function sameFacets(left: PersonalActivityRecord, right: PersonalActivityRecord): boolean {
  return left.taskCategory === right.taskCategory
    && left.routinePattern === right.routinePattern
    && left.automationCandidate === right.automationCandidate
    && left.energyStressMarker === right.energyStressMarker
    && left.routineId === right.routineId
    && left.routineLabel === right.routineLabel
    && left.recurrence === right.recurrence
    && left.durationBucket === right.durationBucket
    && left.system === right.system;
}
