import type { Pool } from "pg";
import type {
  PilotStatusActivity,
  PilotStatusMessageDate,
  PilotStatusParticipantSnapshot,
  PilotStatusStore,
} from "../../application/pilot-status.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

type ParticipantRow = {
  employee_id: string;
  company_id: string;
  company_name: string;
  group_id: string;
  group_name: string;
  period_from: string;
  period_to_exclusive: string;
  role_name: string | null;
  status: PilotStatusParticipantSnapshot["status"];
  last_touch_on: string | Date | null;
  timezone: string | null;
  messages: string;
  activities: string;
  traces: string;
  schedules: string;
  fires: string;
  failed_fires: string;
};

type ActivityRow = {
  employee_id: string;
  task_category: PilotStatusActivity["task_category"] | null;
  system: PilotStatusActivity["system"] | null;
  duration_bucket: PilotStatusActivity["duration_bucket"] | null;
  obstacle_kind: PilotStatusActivity["obstacle_kind"] | null;
  obstacle_value: string | null;
  activity_date: string;
};

type MessageDateRow = { employee_id: string; message_date: string; count: string };
type CountRow = { count: string };
type ControlTotalsRow = { participants: string; messages: string; activities: string; traces: string };

/** Metadata-only operator snapshot. SQL deliberately omits message/profile text and Telegram tables. */
export function createPostgresPilotStatusStore(pool: Pool): PilotStatusStore {
  return {
    async loadSnapshot() {
      try {
        return await withTransaction(pool, async (client) => {
          await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const [participantResult, activityResult, messageDateResult, feedbackResult, traceCoverageResult, controlTotalsResult] = await Promise.all([
            client.query<ParticipantRow>(participantQuery),
            client.query<ActivityRow>(activityQuery),
            client.query<MessageDateRow>(messageDateQuery),
            client.query<CountRow>("SELECT count(*)::text AS count FROM minutka_private.feedback"),
            client.query<CountRow>(`SELECT count(DISTINCT trace.message_id)::text AS count
              FROM minutka_research.traces trace
              JOIN minutka_private.messages message ON message.message_id = trace.message_id
              JOIN minutka_private.participants participant
                ON participant.employee_id = message.employee_id AND participant.subject_key = trace.subject_key`),
            client.query<ControlTotalsRow>(`SELECT
              (SELECT count(*) FROM minutka_private.participants)::text AS participants,
              (SELECT count(*) FROM minutka_private.messages)::text AS messages,
              (SELECT count(*) FROM minutka_private.activities)::text AS activities,
              (SELECT count(*)
                 FROM minutka_research.traces trace
                 JOIN minutka_private.participants participant
                   ON participant.company_id = trace.company_id
                  AND participant.group_id = trace.group_id
                  AND participant.subject_key = trace.subject_key)::text AS traces`),
          ]);
          return {
            participants: participantResult.rows.map(toParticipant),
            activities: activityResult.rows.map(toActivity),
            messagesByDate: messageDateResult.rows.map((row): PilotStatusMessageDate => ({
              employee_id: row.employee_id,
              message_date: row.message_date,
              count: Number(row.count),
            })),
            feedbackCount: Number(feedbackResult.rows[0]?.count ?? 0),
            traceCoveredMessages: Number(traceCoverageResult.rows[0]?.count ?? 0),
            controlTotals: {
              participants: Number(controlTotalsResult.rows[0]?.participants ?? 0),
              messages: Number(controlTotalsResult.rows[0]?.messages ?? 0),
              activities: Number(controlTotalsResult.rows[0]?.activities ?? 0),
              traces: Number(controlTotalsResult.rows[0]?.traces ?? 0),
            },
          };
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}

const participantQuery = `SELECT participant.employee_id, participant.company_id, company.name AS company_name,
  participant.group_id, training_group.name AS group_name,
  lower(training_group.period)::text AS period_from, upper(training_group.period)::text AS period_to_exclusive,
  role.name AS role_name, participant.status, participant.last_touch_on, profile.timezone,
  (SELECT count(*) FROM minutka_private.messages message WHERE message.employee_id = participant.employee_id)::text AS messages,
  (SELECT count(*) FROM minutka_private.activities activity WHERE activity.employee_id = participant.employee_id)::text AS activities,
  (SELECT count(*) FROM minutka_research.traces trace
    WHERE trace.company_id = participant.company_id AND trace.group_id = participant.group_id
      AND trace.subject_key = participant.subject_key)::text AS traces,
  (SELECT count(*) FROM minutka_private.process_schedules schedule WHERE schedule.user_id = participant.employee_id)::text AS schedules,
  (SELECT count(*) FROM minutka_private.schedule_fires fire WHERE fire.user_id = participant.employee_id)::text AS fires,
  (SELECT count(*) FROM minutka_private.schedule_fires fire
    WHERE fire.user_id = participant.employee_id AND fire.status = 'failed')::text AS failed_fires
FROM minutka_private.participants participant
JOIN minutka_reference.companies company ON company.id = participant.company_id
JOIN minutka_reference.training_groups training_group
  ON training_group.company_id = participant.company_id AND training_group.id = participant.group_id
LEFT JOIN minutka_reference.roles role
  ON role.company_id = participant.company_id AND role.id = participant.role_id
LEFT JOIN minutka_private.profiles profile ON profile.employee_id = participant.employee_id
ORDER BY participant.company_id, participant.group_id, participant.created_at, participant.employee_id`;

const activityQuery = `SELECT employee_id, task_category, system, duration_bucket, obstacle_kind, obstacle_value,
  activity_date::text AS activity_date
FROM minutka_private.activities
ORDER BY activity_date, recorded_at, activity_id`;

const messageDateQuery = `SELECT message.employee_id, message.created_at::date::text AS message_date, count(*)::text AS count
FROM minutka_private.messages message
GROUP BY message.employee_id, message.created_at::date
ORDER BY message.created_at::date, message.employee_id`;

function toParticipant(row: ParticipantRow): PilotStatusParticipantSnapshot {
  return {
    employeeId: row.employee_id,
    companyId: row.company_id,
    companyName: row.company_name,
    groupId: row.group_id,
    groupName: row.group_name,
    periodFrom: row.period_from,
    periodToExclusive: row.period_to_exclusive,
    ...(row.role_name ? { roleName: row.role_name } : {}),
    status: row.status,
    ...(row.last_touch_on ? { lastTouchOn: calendarDate(row.last_touch_on) } : {}),
    ...(row.timezone ? { timezone: row.timezone } : {}),
    messages: Number(row.messages),
    activities: Number(row.activities),
    traces: Number(row.traces),
    schedules: Number(row.schedules),
    fires: Number(row.fires),
    failedFires: Number(row.failed_fires),
  };
}

function toActivity(row: ActivityRow): PilotStatusActivity {
  return {
    employee_id: row.employee_id,
    ...(row.task_category ? { task_category: row.task_category } : {}),
    ...(row.system ? { system: row.system } : {}),
    ...(row.duration_bucket ? { duration_bucket: row.duration_bucket } : {}),
    ...(row.obstacle_kind ? { obstacle_kind: row.obstacle_kind } : {}),
    ...(row.obstacle_value ? { obstacle_value: row.obstacle_value } : {}),
    activity_date: row.activity_date,
  };
}

function calendarDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
