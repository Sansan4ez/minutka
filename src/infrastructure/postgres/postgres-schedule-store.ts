import type { Pool } from "pg";
import { z } from "zod";
import { assertUserId } from "../../application/document-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { CompleteScheduleFireInput, SaveProcessScheduleInput, ScheduleStore } from "../../application/schedule-store.js";
import type { ProcessSchedule, ScheduleFire } from "../../domain/schedule.js";
import { normalizeIanaTimezone } from "../../shared/iana-timezone.js";
import { nextDailyFireAt, normalizeDailyTime } from "../../shared/schedule-time.js";
import { withTransaction } from "./postgres-pool.js";

const scheduleSchema = z.strictObject({
  id: z.string().min(1), userId: z.string().min(1), processId: z.string().min(1),
  timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), timezone: z.string().min(1),
  enabled: z.boolean(), nextFireAt: z.iso.datetime(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const fireSchema = z.strictObject({
  scheduleId: z.string().min(1), userId: z.string().min(1), processId: z.string().min(1),
  scheduledFor: z.iso.datetime(), status: z.enum(["pending", "succeeded", "failed"]),
  createdAt: z.iso.datetime(), completedAt: z.iso.datetime().optional(), errorCode: z.string().min(1).optional(),
});

type ScheduleRow = {
  schedule_id: string; user_id: string; process_id: string; time_of_day: string; timezone: string;
  enabled: boolean; next_fire_at: Date; created_at: Date; updated_at: Date;
};
type FireRow = {
  schedule_id: string; user_id: string; process_id: string; scheduled_for: Date;
  status: string; created_at: Date; completed_at: Date | null; error_code: string | null;
};

export function createPostgresScheduleStore(pool: Pool): ScheduleStore {
  return {
    async save(userId, input) {
      const safeUserId = assertUserId(userId);
      const normalized = normalizeScheduleInput(input);
      try {
        const result = await pool.query<ScheduleRow>(
          `INSERT INTO minutka_private.process_schedules
             (schedule_id,user_id,process_id,time_of_day,timezone,enabled,next_fire_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)
           ON CONFLICT (schedule_id) DO UPDATE SET
             process_id=EXCLUDED.process_id,time_of_day=EXCLUDED.time_of_day,timezone=EXCLUDED.timezone,
             enabled=EXCLUDED.enabled,next_fire_at=EXCLUDED.next_fire_at,updated_at=now()
           WHERE process_schedules.user_id=EXCLUDED.user_id
           RETURNING *`,
          [normalized.id, safeUserId, normalized.processId, normalized.timeOfDay, normalized.timezone,
            normalized.enabled, normalized.nextFireAt],
        );
        if (!result.rows[0]) throw { code: "23505" };
        return restoreSchedule(result.rows[0]);
      } catch (error) { throw mapPostgresError(error); }
    },
    async get(userId, scheduleId) {
      const safeUserId = assertUserId(userId);
      const safeScheduleId = requiredText(scheduleId, "schedule id");
      try {
        const result = await pool.query<ScheduleRow>(
          "SELECT * FROM minutka_private.process_schedules WHERE user_id=$1 AND schedule_id=$2",
          [safeUserId, safeScheduleId],
        );
        return result.rows[0] ? restoreSchedule(result.rows[0]) : null;
      } catch (error) { throw mapPostgresError(error); }
    },
    async claimDue(now, limit = 100) {
      const safeNow = timestamp(now, "now");
      const safeLimit = positiveLimit(limit);
      try {
        return await withTransaction(pool, async (client) => {
          const due = await client.query<ScheduleRow>(
            `SELECT * FROM minutka_private.process_schedules
             WHERE enabled AND next_fire_at <= $1::timestamptz
             ORDER BY next_fire_at, schedule_id`,
            [safeNow],
          );
          for (const row of due.rows) {
            const schedule = restoreSchedule(row);
            await client.query(
              `INSERT INTO minutka_private.schedule_fires
                 (schedule_id,user_id,process_id,scheduled_for)
               VALUES ($1,$2,$3,$4::timestamptz)
               ON CONFLICT (schedule_id,scheduled_for) DO NOTHING`,
              [schedule.id, schedule.userId, schedule.processId, schedule.nextFireAt],
            );
            const nextFireAt = nextDailyFireAt({
              after: safeNow,
              timeOfDay: schedule.timeOfDay,
              timezone: schedule.timezone,
            });
            await client.query(
              `UPDATE minutka_private.process_schedules
               SET next_fire_at=$2::timestamptz,updated_at=now()
               WHERE schedule_id=$1 AND next_fire_at=$3::timestamptz`,
              [schedule.id, nextFireAt, schedule.nextFireAt],
            );
          }
          const pending = await client.query<FireRow>(
            `SELECT * FROM minutka_private.schedule_fires
             WHERE status='pending'
             ORDER BY created_at,schedule_id,scheduled_for
             LIMIT $1`,
            [safeLimit],
          );
          return pending.rows.map(restoreFire);
        });
      } catch (error) { throw mapPostgresError(error); }
    },
    async listFires(userId, scheduleId) {
      const safeUserId = assertUserId(userId);
      const safeScheduleId = scheduleId === undefined ? undefined : requiredText(scheduleId, "schedule id");
      try {
        const result = safeScheduleId === undefined
          ? await pool.query<FireRow>(
            "SELECT * FROM minutka_private.schedule_fires WHERE user_id=$1 ORDER BY created_at,schedule_id,scheduled_for",
            [safeUserId],
          )
          : await pool.query<FireRow>(
            "SELECT * FROM minutka_private.schedule_fires WHERE user_id=$1 AND schedule_id=$2 ORDER BY created_at,scheduled_for",
            [safeUserId, safeScheduleId],
          );
        return result.rows.map(restoreFire);
      } catch (error) { throw mapPostgresError(error); }
    },
    async completeFire(userId, input) {
      const safeUserId = assertUserId(userId);
      validateCompletion(input);
      const safeScheduleId = requiredText(input.scheduleId, "schedule id");
      const safeScheduledFor = timestamp(input.scheduledFor, "scheduledFor");
      try {
        const result = await pool.query<FireRow>(
          `UPDATE minutka_private.schedule_fires SET
             status=$4,completed_at=now(),error_code=$5
           WHERE user_id=$1 AND schedule_id=$2 AND scheduled_for=$3::timestamptz AND status='pending'
           RETURNING *`,
          [safeUserId, safeScheduleId, safeScheduledFor,
            input.status, input.status === "failed" ? input.errorCode : null],
        );
        if (result.rows[0]) return restoreFire(result.rows[0]);
        const existing = await pool.query<FireRow>(
          "SELECT * FROM minutka_private.schedule_fires WHERE user_id=$1 AND schedule_id=$2 AND scheduled_for=$3::timestamptz",
          [safeUserId, safeScheduleId, safeScheduledFor],
        );
        return existing.rows[0] ? restoreFire(existing.rows[0]) : null;
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

function restoreSchedule(row: ScheduleRow): ProcessSchedule {
  return scheduleSchema.parse({ id: row.schedule_id, userId: row.user_id, processId: row.process_id,
    timeOfDay: row.time_of_day, timezone: row.timezone, enabled: row.enabled,
    nextFireAt: row.next_fire_at.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
}
function restoreFire(row: FireRow): ScheduleFire {
  return fireSchema.parse({ scheduleId: row.schedule_id, userId: row.user_id, processId: row.process_id,
    scheduledFor: row.scheduled_for.toISOString(), status: row.status, createdAt: row.created_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}) });
}
function normalizeScheduleInput(input: SaveProcessScheduleInput): SaveProcessScheduleInput {
  const timezone = normalizeIanaTimezone(input.timezone);
  if (!timezone) throw new Error("timezone must be a valid IANA timezone");
  return { ...input, id: requiredText(input.id, "schedule id"), processId: requiredText(input.processId, "process id"),
    timeOfDay: normalizeDailyTime(input.timeOfDay), timezone, nextFireAt: timestamp(input.nextFireAt, "nextFireAt") };
}
function validateCompletion(input: CompleteScheduleFireInput): void {
  if (input.status === "succeeded" && input.errorCode !== undefined) throw new Error("succeeded fire must not have errorCode");
  if (input.status === "failed") requiredText(input.errorCode ?? "", "errorCode");
}
function requiredText(value: string, field: string): string { if (!value.trim()) throw new Error(`${field} is required`); return value; }
function timestamp(value: string, field: string): string { const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new Error(`${field} must be a valid timestamp`); return date.toISOString(); }
function positiveLimit(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new Error("limit must be between 1 and 1000"); return value; }
