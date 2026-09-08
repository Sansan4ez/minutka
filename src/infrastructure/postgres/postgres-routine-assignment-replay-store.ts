import type { Pool } from "pg";
import type {
  RoutineAssignmentReplayInput,
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
            source_message_id: string | null;
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
             SET routine_id=$1, routine_label=$2, revision=revision+1,
                 last_correction_message_id=$3, updated_at=now()
             WHERE activity_id=$4 AND company_id=$5 AND group_id=$6 AND role_id=$7
               AND status='active' AND routine_id IS NULL AND routine_label IS NULL
             RETURNING source_message_id, task_category, routine_pattern, automation_candidate,
                       energy_stress_marker, duration_bucket, system, recurrence, revision, status,
                       superseded_by_activity_id`,
            [assignment.routineId, assignment.routineLabel, replaySource(input), assignment.activityId,
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
             VALUES ($1,$2,'corrected',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`,
            [assignment.activityId, current.revision, current.source_message_id, current.task_category,
              current.routine_pattern, current.automation_candidate, current.energy_stress_marker,
              current.duration_bucket, current.system, assignment.routineId, assignment.routineLabel,
              current.recurrence, current.status, current.superseded_by_activity_id],
          );
          applied += 1;
        }
        return {
          status: applied === 0 ? "already_applied" : "applied",
          assignments: input.assignments.length,
          applied,
          alreadyApplied,
        } satisfies RoutineAssignmentReplayResult;
      });
    },
  };
}

function replaySource(input: RoutineAssignmentReplayInput): string {
  return `operator_replay:${input.source.corpusExportedAt}`;
}
