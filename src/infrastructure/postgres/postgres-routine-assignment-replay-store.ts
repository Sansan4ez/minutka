import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { safeAuditMetadata } from "../../application/audit-event-store.js";
import type {
  RoutineAssignmentReplayResult,
  RoutineAssignmentReplayStore,
} from "../../application/routine-assignment-replay.js";
import { withTransaction } from "./postgres-pool.js";

export function createPostgresRoutineAssignmentReplayStore(pool: Pool): RoutineAssignmentReplayStore {
  return {
    async replay(input) {
      return withTransaction(pool, async (client) => {
        let applied = 0;
        let alreadyApplied = 0;
        for (const assignment of input.assignments) {
          const result = await client.query<{
            task_category: string | null;
            routine_pattern: string | null;
            automation_candidate: string | null;
            energy_stress_marker: string | null;
            duration_bucket: string | null;
            system: string | null;
            recurrence: string | null;
            revision: number;
            status: string;
            superseded_by_activity_id: string | null;
          }>(
            `UPDATE minutka_private.activities
             SET routine_id=$1, routine_label=$2, revision=revision+1, updated_at=now()
             WHERE activity_id=$3 AND company_id=$4 AND group_id=$5 AND role_id=$6
               AND status='active' AND routine_id IS NULL AND routine_label IS NULL
             RETURNING task_category, routine_pattern, automation_candidate,
                       energy_stress_marker, duration_bucket, system, recurrence, revision, status,
                       superseded_by_activity_id`,
            [assignment.routineId, assignment.routineLabel, assignment.activityId,
              input.companyId, input.groupId, assignment.roleId],
          );
          const current = result.rows[0];
          if (current === undefined) {
            const existing = await client.query<{ routine_id: string | null; routine_label: string | null }>(
              `SELECT routine_id, routine_label FROM minutka_private.activities
               WHERE activity_id=$1 AND company_id=$2 AND group_id=$3 AND role_id=$4 AND status='active'`,
              [assignment.activityId, input.companyId, input.groupId, assignment.roleId],
            );
            if (existing.rows[0]?.routine_id === assignment.routineId
              && existing.rows[0]?.routine_label === assignment.routineLabel) {
              alreadyApplied += 1;
              continue;
            }
            throw new Error(`routine assignment conflicts with canonical activity ${JSON.stringify(assignment.activityId)}`);
          }
          await client.query(
            `INSERT INTO minutka_private.activity_revisions
              (activity_id, revision, operation, source_message_id, task_category, routine_pattern,
               automation_candidate, energy_stress_marker, duration_bucket, system, routine_id,
               routine_label, recurrence, status, superseded_by_activity_id, changed_at)
             VALUES ($1,$2,'corrected',NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())`,
            [assignment.activityId, current.revision, current.task_category,
              current.routine_pattern, current.automation_candidate, current.energy_stress_marker,
              current.duration_bucket, current.system, assignment.routineId, assignment.routineLabel,
              current.recurrence, current.status, current.superseded_by_activity_id],
          );
          applied += 1;
        }
        const replayResult = {
          status: applied === 0 ? "already_applied" : "applied",
          assignments: input.assignments.length,
          applied,
          alreadyApplied,
        } satisfies RoutineAssignmentReplayResult;
        await client.query(
          `INSERT INTO minutka_audit.events(event_id, request_id, event_type, metadata, occurred_at)
           VALUES ($1,$2,'routine_assignment_replay_applied',$3::jsonb,now())`,
          [
            `evt_${randomUUID()}`,
            `req_routine_assignment_replay_${randomUUID()}`,
            JSON.stringify(safeAuditMetadata("routine_assignment_replay_applied", {
              scope: `${input.companyId}/${input.groupId}`,
              directoryVersion: input.source.directoryVersion,
              corpusExportedAt: input.source.corpusExportedAt,
              assignments: replayResult.assignments,
              applied: replayResult.applied,
              alreadyApplied: replayResult.alreadyApplied,
            })),
          ],
        );
        return replayResult;
      });
    },
  };
}
