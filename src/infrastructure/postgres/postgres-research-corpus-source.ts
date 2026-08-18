import type { Pool } from "pg";
import type { ResearchCorpusSource } from "../../application/research-corpus-export.js";
import type { ResearchEvidenceRef, ResearchSubject } from "../../application/research-identity-projection.js";
import type { PersonalActivityRecord } from "../../application/activity-collection.js";
import { mapPostgresError } from "../../application/persistence-error.js";

type SubjectRow = { company_id: string; group_id: string; subject_key: string; role_id: string | null; message_ids: string[]; activity_ids: string[]; trace_ids: string[] };
type MessageRow = { message_id: string; subject_key: string; user_text: string; agent_response: string; created_at: Date };
type ActivityRow = { activity_id: string; subject_key: string; source_message_id: string | null; company_id: string; group_id: string; role_id: string; task_category: PersonalActivityRecord["taskCategory"] | null; obstacle_kind: PersonalActivityRecord["obstacle"] extends infer T ? T extends { kind: infer K } ? K : never : never; obstacle_value: string | null; duration_bucket: PersonalActivityRecord["durationBucket"] | null; system: PersonalActivityRecord["system"] | null; activity_date: string; recorded_at: Date };
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
          `SELECT activity_id, subject_key, source_message_id, company_id, group_id, role_id, task_category,
                  obstacle_kind, obstacle_value, duration_bucket, system, activity_date::text AS activity_date, recorded_at
           FROM minutka_private.activities WHERE company_id=$1 AND group_id=$2 ORDER BY recorded_at, activity_id`,
          [companyId, groupId],
        );
        return result.rows.map((row) => ({
          activityId: row.activity_id, subjectKey: row.subject_key,
          ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
          companyId: row.company_id, groupId: row.group_id, roleId: row.role_id,
          ...(row.task_category ? { taskCategory: row.task_category } : {}),
          ...(row.obstacle_kind && row.obstacle_value ? { obstacle: { kind: row.obstacle_kind, value: row.obstacle_value } as PersonalActivityRecord["obstacle"] } : {}),
          ...(row.duration_bucket ? { durationBucket: row.duration_bucket } : {}),
          ...(row.system ? { system: row.system } : {}), activityDate: row.activity_date, recordedAt: row.recorded_at.toISOString(),
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
