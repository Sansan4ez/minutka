import type { Pool } from "pg";
import type { ResearchCorpusSource } from "../../application/research-corpus-export.js";
import type { ResearchEvidenceRef, ResearchSubject } from "../../application/research-identity-projection.js";
import type { PersonalActivityRecord } from "../../application/activity-collection.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { ActivityRevisionRecord, ActivityStatus } from "../../application/activity-correction.js";
import { canonicalActivityRevisionChangedAtSql } from "./postgres-activity-revision-projection.js";

type SubjectRow = { company_id: string; group_id: string; subject_key: string; role_id: string | null; message_ids: string[]; activity_ids: string[]; trace_ids: string[] };
type MessageRow = { message_id: string; subject_key: string; user_text: string; agent_response: string; created_at: Date };
type ActivityRow = {
  activity_id: string; subject_key: string; source_message_id: string | null; company_id: string; group_id: string; role_id: string;
  task_category: PersonalActivityRecord["taskCategory"] | null;
  routine_pattern: PersonalActivityRecord["routinePattern"] | null;
  automation_candidate: PersonalActivityRecord["automationCandidate"] | null;
  energy_stress_marker: PersonalActivityRecord["energyStressMarker"] | null;
  duration_bucket: PersonalActivityRecord["durationBucket"] | null;
  system: PersonalActivityRecord["system"] | null;
  routine_id: PersonalActivityRecord["routineId"] | null;
  routine_label: PersonalActivityRecord["routineLabel"] | null;
  recurrence: PersonalActivityRecord["recurrence"] | null;
  activity_date: string; recorded_at: Date;
  revision: number; status: ActivityStatus; superseded_by_activity_id: string | null;
  last_correction_message_id: string | null; updated_at: Date; revisions: ActivityRevisionRecord[];
};
type FeedbackRow = { feedback_id: string; target_message_id: string; rating: "positive" | "neutral" | "negative"; created_at: Date; updated_at: Date };

export function createPostgresResearchCorpusSource(pool: Pool): ResearchCorpusSource {
  return {
    async listSubjects({ companyId, groupId }) {
      try {
        const result = await pool.query<SubjectRow>(
          `SELECT participant.company_id, participant.group_id, participant.subject_key, participant.role_id,
             COALESCE((SELECT array_agg(message_id ORDER BY created_at, message_id) FROM minutka_private.messages WHERE subject_key=participant.subject_key), ARRAY[]::text[]) AS message_ids,
             COALESCE((SELECT array_agg(activity_id ORDER BY recorded_at, activity_id) FROM minutka_private.activities WHERE subject_key=participant.subject_key), ARRAY[]::text[]) AS activity_ids,
             COALESCE((SELECT array_agg(trace_id ORDER BY started_at, trace_id) FROM minutka_research.traces WHERE subject_key=participant.subject_key), ARRAY[]::text[]) AS trace_ids
           FROM minutka_private.participants participant
           WHERE participant.company_id=$1 AND participant.group_id=$2
           ORDER BY participant.subject_key`,
          [companyId, groupId],
        );
        return result.rows.map((row): ResearchSubject => ({
          companyId: row.company_id, groupId: row.group_id, subjectKey: row.subject_key,
          ...(row.role_id ? { roleId: row.role_id } : {}),
          evidenceRefs: [
            ...row.message_ids.map((id): ResearchEvidenceRef => ({ kind: "message", id })),
            ...row.activity_ids.map((id): ResearchEvidenceRef => ({ kind: "activity", id })),
            ...row.trace_ids.map((id): ResearchEvidenceRef => ({ kind: "trace", id })),
          ],
        }));
      } catch (error) { throw mapPostgresError(error); }
    },
    async listMessages({ companyId, groupId }) {
      try {
        const result = await pool.query<MessageRow>(
          `SELECT message.message_id, message.subject_key, message.user_text, message.agent_response, message.created_at
           FROM minutka_private.messages message
           JOIN minutka_private.participants participant ON participant.subject_key=message.subject_key
           WHERE participant.company_id=$1 AND participant.group_id=$2
           ORDER BY message.created_at, message.message_id`,
          [companyId, groupId],
        );
        return result.rows.map((row) => ({ messageId: row.message_id, subjectKey: row.subject_key, userText: row.user_text, agentResponse: row.agent_response, timestamp: row.created_at.toISOString() }));
      } catch (error) { throw mapPostgresError(error); }
    },
    async listActivities({ companyId, groupId }) {
      try {
        const result = await pool.query<ActivityRow>(
          `SELECT activity.activity_id, activity.subject_key, activity.source_message_id, activity.company_id,
                  activity.group_id, activity.role_id, activity.task_category, activity.routine_pattern,
                  activity.automation_candidate, activity.energy_stress_marker, activity.duration_bucket,
                  activity.system, activity.routine_id, activity.routine_label, activity.recurrence,
                  activity.activity_date::text AS activity_date, activity.recorded_at,
                  activity.revision, activity.status, activity.superseded_by_activity_id,
                  activity.last_correction_message_id, activity.updated_at,
                  COALESCE((SELECT json_agg(json_strip_nulls(json_build_object(
                    'revision', history.revision, 'operation', history.operation,
                    'sourceMessageId', history.source_message_id, 'taskCategory', history.task_category,
                    'routinePattern', history.routine_pattern, 'automationCandidate', history.automation_candidate,
                    'energyStressMarker', history.energy_stress_marker, 'routineId', history.routine_id,
                    'routineLabel', history.routine_label, 'recurrence', history.recurrence,
                    'durationBucket', history.duration_bucket, 'system', history.system, 'status', history.status,
                    'supersededByActivityId', history.superseded_by_activity_id,
                    'changedAt', ${canonicalActivityRevisionChangedAtSql})) ORDER BY history.revision)
                    FROM minutka_private.activity_revisions history
                    WHERE history.activity_id=activity.activity_id), '[]'::json) AS revisions
           FROM minutka_private.activities activity
           WHERE activity.company_id=$1 AND activity.group_id=$2
           ORDER BY activity.recorded_at, activity.activity_id`,
          [companyId, groupId],
        );
        return result.rows.map((row) => ({
          activityId: row.activity_id, subjectKey: row.subject_key,
          ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
          companyId: row.company_id, groupId: row.group_id, roleId: row.role_id,
          ...(row.task_category ? { taskCategory: row.task_category } : {}),
          ...(row.routine_pattern ? { routinePattern: row.routine_pattern } : {}),
          ...(row.automation_candidate ? { automationCandidate: row.automation_candidate } : {}),
          ...(row.energy_stress_marker ? { energyStressMarker: row.energy_stress_marker } : {}),
          ...(row.duration_bucket ? { durationBucket: row.duration_bucket } : {}),
          ...(row.system ? { system: row.system } : {}),
          ...(row.routine_id ? { routineId: row.routine_id } : {}),
          ...(row.routine_label ? { routineLabel: row.routine_label } : {}),
          ...(row.recurrence ? { recurrence: row.recurrence } : {}),
          activityDate: row.activity_date, recordedAt: row.recorded_at.toISOString(),
          revision: row.revision, status: row.status,
          ...(row.superseded_by_activity_id ? { supersededByActivityId: row.superseded_by_activity_id } : {}),
          ...(row.last_correction_message_id ? { lastCorrectionMessageId: row.last_correction_message_id } : {}),
          updatedAt: row.updated_at.toISOString(), revisions: row.revisions,
        }));
      } catch (error) { throw mapPostgresError(error); }
    },
    async listFeedback({ companyId, groupId }) {
      try {
        const result = await pool.query<FeedbackRow>(
          `SELECT feedback.feedback_id, feedback.target_message_id, feedback.rating, feedback.created_at, feedback.updated_at
           FROM minutka_private.feedback feedback
           JOIN minutka_private.messages message ON message.message_id=feedback.target_message_id
           JOIN minutka_private.participants participant ON participant.subject_key=message.subject_key
           WHERE participant.company_id=$1 AND participant.group_id=$2
           ORDER BY feedback.created_at, feedback.feedback_id`,
          [companyId, groupId],
        );
        return result.rows.map((row) => ({ feedbackId: row.feedback_id, targetMessageId: row.target_message_id, rating: row.rating, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}
