import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ParticipationTransitionStore } from "../../application/participation-transition.js";
import { defaultScheduleId } from "../../application/schedule-management-service.js";
import type { AssistantScheduledProcessId } from "../../domain/assistant-process.js";
import { nextDailyFireAt } from "../../shared/schedule-time.js";
import { withTransaction } from "./postgres-pool.js";

type Participant = { employee_id: string; company_id: string; group_id: string; status: string; role_id: string | null; subject_key: string };

export function createPostgresParticipationTransitionStore(pool: Pool): ParticipationTransitionStore {
  return { async transition(input) {
    return withTransaction(pool, async client => {
      const rows = await client.query<Participant>("SELECT * FROM minutka_private.participants WHERE employee_id=ANY($1::text[]) ORDER BY employee_id FOR UPDATE", [[input.sourceEmployeeId, input.targetEmployeeId]]);
      const source = rows.rows.find(x => x.employee_id === input.sourceEmployeeId);
      const target = rows.rows.find(x => x.employee_id === input.targetEmployeeId);
      if (!source || !target || source.company_id !== input.companyId || target.company_id !== input.companyId || source.group_id !== input.sourceGroupId || target.group_id !== input.targetGroupId || source.subject_key === target.subject_key) throw new Error("participation_scope_mismatch");
      const session = await client.query<{ employee_id: string; thread_id: string; consent_accepted_at: Date | null }>("SELECT employee_id,thread_id,consent_accepted_at FROM minutka_private.telegram_sessions WHERE employee_id=ANY($1::text[]) FOR UPDATE", [[source.employee_id, target.employee_id]]);
      const oldSession = session.rows.find(x => x.employee_id === source.employee_id);
      const newSession = session.rows.find(x => x.employee_id === target.employee_id);
      if (!oldSession && newSession) {
        const receipt = await client.query("SELECT 1 FROM minutka_private.participation_transitions WHERE source_employee_id=$1 AND target_employee_id=$2", [source.employee_id, target.employee_id]);
        if (receipt.rowCount) return { status: "already_applied", threadId: newSession.thread_id };
      }
      if (!oldSession || newSession || target.status !== "invite_issued" || !["consent_accepted", "profile_completed"].includes(source.status)) throw new Error("participation_not_ready");
      const consent = await client.query("SELECT 1 FROM minutka_private.consents WHERE employee_id=$1", [source.employee_id]);
      if (!consent.rowCount || !oldSession.consent_accepted_at) throw new Error("existing_consent_required");
      const occupied = await client.query("SELECT 1 FROM minutka_private.profiles WHERE employee_id=$1 UNION ALL SELECT 1 FROM minutka_private.onboarding_drafts WHERE employee_id=$1 UNION ALL SELECT 1 FROM minutka_private.messages WHERE employee_id=$1 UNION ALL SELECT 1 FROM minutka_private.process_schedules WHERE user_id=$1", [target.employee_id]);
      if (occupied.rowCount) throw new Error("target_not_empty");
      await client.query("UPDATE minutka_private.participants SET status=$2,role_id=$3,privacy_explanation_shown_at=(SELECT privacy_explanation_shown_at FROM minutka_private.participants WHERE employee_id=$4),updated_at=now() WHERE employee_id=$1", [target.employee_id, source.status, source.role_id, source.employee_id]);
      await client.query("INSERT INTO minutka_private.consents SELECT $2,privacy_version,accepted_at,explanation_shown_at,source FROM minutka_private.consents WHERE employee_id=$1", [source.employee_id, target.employee_id]);
      const profile = await client.query(`INSERT INTO minutka_private.profiles (employee_id,role,typical_tasks,persona,ai_level,response_length,preferred_checkins_per_day,created_at,updated_at,preferred_name,assistant_name,address_form,timezone,role_id,program_goal)
        SELECT $2,role,typical_tasks,persona,ai_level,response_length,preferred_checkins_per_day,created_at,now(),preferred_name,assistant_name,address_form,timezone,role_id,program_goal FROM minutka_private.profiles WHERE employee_id=$1`, [source.employee_id, target.employee_id]);
      if (source.status === "profile_completed" && profile.rowCount !== 1) throw new Error("source_profile_missing");
      await client.query(`INSERT INTO minutka_private.onboarding_drafts (employee_id,persona,status,pending_field,revision,created_at,updated_at,expires_at,preferred_name,assistant_name,address_form,response_length,timezone,role_id)
        SELECT $2,persona,status,pending_field,revision,created_at,now(),expires_at,preferred_name,assistant_name,address_form,response_length,timezone,role_id FROM minutka_private.onboarding_drafts WHERE employee_id=$1`, [source.employee_id, target.employee_id]);
      const pending = await client.query("SELECT 1 FROM minutka_private.schedule_fires WHERE user_id=$1 AND status='pending'", [source.employee_id]);
      if (pending.rowCount) throw new Error("pending_schedule_fire");
      const schedules = await client.query<{ schedule_id: string; process_id: AssistantScheduledProcessId; time_of_day: string; timezone: string; days_of_week: number }>("SELECT * FROM minutka_private.process_schedules WHERE user_id=$1 AND kind='process' AND NOT one_shot AND process_id=ANY($2::text[])", [source.employee_id, ["morning_planning", "evening_reflection", "weekly_summary"]]);
      for (const schedule of schedules.rows) {
        const next = nextDailyFireAt({ after: new Date().toISOString(), timeOfDay: schedule.time_of_day, timezone: schedule.timezone, daysOfWeek: schedule.days_of_week });
        await client.query(`INSERT INTO minutka_private.process_schedules (schedule_id,user_id,process_id,time_of_day,timezone,enabled,next_fire_at,days_of_week,kind,one_shot)
          SELECT $2,$3,process_id,time_of_day,timezone,enabled,$4,days_of_week,kind,one_shot FROM minutka_private.process_schedules WHERE schedule_id=$1`, [schedule.schedule_id, defaultScheduleId(target.employee_id, schedule.process_id), target.employee_id, next]);
      }
      await client.query("UPDATE minutka_private.process_schedules SET enabled=false,updated_at=now() WHERE user_id=$1", [source.employee_id]);
      // Revoke the old invite without deleting historical participation/corpus.
      await client.query("UPDATE minutka_private.participants SET invite_code_digest=$2,updated_at=now() WHERE employee_id=$1", [source.employee_id, randomBytes(32)]);
      const threadId = randomUUID();
      await client.query("INSERT INTO minutka_private.threads(employee_id,thread_id,created_at,updated_at) VALUES($1,$2,now(),now())", [target.employee_id, threadId]);
      await client.query(`UPDATE minutka_private.telegram_sessions SET employee_id=$2,thread_id=$3,updated_at=now(),onboarding_confirmation_delivery_key=NULL,onboarding_confirmation_claim_key=NULL,onboarding_confirmation_claimed_at=NULL WHERE employee_id=$1`, [source.employee_id, target.employee_id, threadId]);
      await client.query("INSERT INTO minutka_private.participation_transitions(source_employee_id,target_employee_id,thread_id) VALUES($1,$2,$3)", [source.employee_id, target.employee_id, threadId]);
      return { status: "applied", threadId };
    });
  } };
}
