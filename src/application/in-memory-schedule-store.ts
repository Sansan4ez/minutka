import type { ProcessSchedule, ScheduleFire } from "../domain/schedule.js";
import { nextDailyFireAt, normalizeDailyTime } from "../shared/schedule-time.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";
import type { CompleteScheduleFireInput, SaveProcessScheduleInput, ScheduleStore } from "./schedule-store.js";

/** Hermetic adapter for scheduler executable specs. */
export function createInMemoryScheduleStore(clock: Clock): ScheduleStore {
  const schedules = new Map<string, ProcessSchedule>();
  const scheduleOwners = new Map<string, string>();
  const fires = new Map<string, ScheduleFire>();
  const scheduleKey = (userId: string, id: string) => `${assertUserId(userId)}\u0000${requiredText(id, "schedule id")}`;
  const fireKey = (scheduleId: string, scheduledFor: string) => `${scheduleId}\u0000${timestamp(scheduledFor, "scheduledFor")}`;

  return {
    async save(userId, input) {
      const safeUserId = assertUserId(userId);
      const normalized = normalizeScheduleInput(input);
      const owner = scheduleOwners.get(normalized.id);
      if (owner !== undefined && owner !== safeUserId) throw new Error("schedule id conflict");
      const key = scheduleKey(safeUserId, normalized.id);
      const existing = schedules.get(key);
      const now = timestamp(clock.now(), "clock");
      const schedule: ProcessSchedule = {
        ...normalized,
        userId: safeUserId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      schedules.set(key, schedule);
      scheduleOwners.set(schedule.id, safeUserId);
      return copySchedule(schedule);
    },
    async get(userId, scheduleId) {
      const schedule = schedules.get(scheduleKey(userId, scheduleId));
      return schedule ? copySchedule(schedule) : null;
    },
    async list(userId) {
      const safeUserId = assertUserId(userId);
      return [...schedules.values()]
        .filter((schedule) => schedule.userId === safeUserId)
        .sort((left, right) => left.timeOfDay.localeCompare(right.timeOfDay) || left.id.localeCompare(right.id))
        .map(copySchedule);
    },
    async claimDue(now, limit = 100) {
      const safeNow = timestamp(now, "now");
      const safeLimit = positiveLimit(limit);
      for (const schedule of [...schedules.values()]
        .filter((candidate) => candidate.enabled && candidate.nextFireAt <= safeNow)
        .sort((left, right) => left.nextFireAt.localeCompare(right.nextFireAt) || left.id.localeCompare(right.id))) {
        const scheduledFor = schedule.nextFireAt;
        const key = fireKey(schedule.id, scheduledFor);
        if (!fires.has(key)) {
          fires.set(key, {
            scheduleId: schedule.id,
            userId: schedule.userId,
            processId: schedule.processId,
            scheduledFor,
            status: "pending",
            createdAt: safeNow,
          });
        }
        schedule.nextFireAt = nextDailyFireAt({ after: safeNow, timeOfDay: schedule.timeOfDay, timezone: schedule.timezone });
        schedule.updatedAt = safeNow;
      }
      return [...fires.values()]
        .filter((fire) => fire.status === "pending")
        .sort(compareFires)
        .slice(0, safeLimit)
        .map(copyFire);
    },
    async listFires(userId, scheduleId) {
      const safeUserId = assertUserId(userId);
      const safeScheduleId = scheduleId === undefined ? undefined : requiredText(scheduleId, "schedule id");
      return [...fires.values()]
        .filter((fire) => fire.userId === safeUserId && (safeScheduleId === undefined || fire.scheduleId === safeScheduleId))
        .sort(compareFires)
        .map(copyFire);
    },
    async completeFire(userId, input) {
      const safeUserId = assertUserId(userId);
      validateCompletion(input);
      const key = fireKey(requiredText(input.scheduleId, "schedule id"), input.scheduledFor);
      const existing = fires.get(key);
      if (!existing || existing.userId !== safeUserId) return null;
      if (existing.status !== "pending") return copyFire(existing);
      const completed: ScheduleFire = {
        ...existing,
        status: input.status,
        completedAt: timestamp(clock.now(), "clock"),
        ...(input.status === "failed" ? { errorCode: requiredText(input.errorCode ?? "", "errorCode") } : {}),
      };
      fires.set(key, completed);
      return copyFire(completed);
    },
  };
}

function normalizeScheduleInput(input: SaveProcessScheduleInput): SaveProcessScheduleInput {
  const timezone = normalizeIanaTimezone(input.timezone);
  if (!timezone) throw new Error("timezone must be a valid IANA timezone");
  return {
    ...input,
    id: requiredText(input.id, "schedule id"),
    processId: requiredText(input.processId, "process id"),
    timeOfDay: normalizeDailyTime(input.timeOfDay),
    timezone,
    nextFireAt: timestamp(input.nextFireAt, "nextFireAt"),
  };
}

function validateCompletion(input: CompleteScheduleFireInput): void {
  if (input.status === "succeeded" && input.errorCode !== undefined) throw new Error("succeeded fire must not have errorCode");
  if (input.status === "failed") requiredText(input.errorCode ?? "", "errorCode");
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value;
}

function timestamp(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new Error("limit must be between 1 and 1000");
  return value;
}

function compareFires(left: ScheduleFire, right: ScheduleFire): number {
  return left.createdAt.localeCompare(right.createdAt) || left.scheduleId.localeCompare(right.scheduleId)
    || left.scheduledFor.localeCompare(right.scheduledFor);
}

function copySchedule(schedule: ProcessSchedule): ProcessSchedule { return { ...schedule }; }
function copyFire(fire: ScheduleFire): ScheduleFire { return { ...fire }; }
