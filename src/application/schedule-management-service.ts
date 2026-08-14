import { isAssistantDiagnosticProcessId, type AssistantDiagnosticProcessId } from "../domain/assistant-process.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { nextDailyFireAt, normalizeDailyTime, normalizeDaysOfWeek } from "../shared/schedule-time.js";
import { assertUserId } from "./document-store.js";
import type { ProfileStore } from "./profile-store.js";
import { randomIdGenerator, type Clock, type IdGenerator } from "./runtime-primitives.js";
import type { ScheduleStore } from "./schedule-store.js";

export type SaveDailyScheduleInput = {
  scheduleId?: string;
  kind?: "process" | "reminder";
  processId?: string;
  reminderText?: string;
  timeOfDay: string;
  timezone?: string;
  daysOfWeek?: number;
  oneShot?: boolean;
};

export type OwnerScheduleCapabilities = {
  listSchedules(): Promise<ProcessSchedule[]>;
  saveDailySchedule(input: SaveDailyScheduleInput): Promise<ProcessSchedule>;
  disableSchedule(scheduleId: string): Promise<ProcessSchedule | null>;
};

/** Typed owner-scoped schedule use-cases shared by chat tools and transports. */
export class ScheduleManagementService {
  constructor(
    private readonly store: Pick<ScheduleStore, "list" | "get" | "save">,
    private readonly profiles: Pick<ProfileStore, "getProfile">,
    private readonly clock: Clock,
    private readonly ids: Pick<IdGenerator, "scheduleId"> = randomIdGenerator,
  ) {}

  listSchedules(userId: string): Promise<ProcessSchedule[]> {
    return this.store.list(assertUserId(userId));
  }

  async saveDailySchedule(userId: string, input: SaveDailyScheduleInput): Promise<ProcessSchedule> {
    const safeUserId = assertUserId(userId);
    const kind = input.kind ?? "process";
    const targetedSchedule = input.scheduleId === undefined ? undefined : await this.store.get(safeUserId, input.scheduleId);
    if (input.scheduleId !== undefined && !targetedSchedule) throw new AssistantScheduleNotFoundError(input.scheduleId);
    if (targetedSchedule && targetedSchedule.kind !== kind) throw new AssistantScheduleKindChangeError(targetedSchedule.kind, kind);
    const process = kind === "process" ? processAction(input) : undefined;
    const action = process ?? reminderAction(input);
    const profile = await this.profiles.getProfile(safeUserId);
    if (!profile) throw new Error("completed owner profile is required to manage schedules");
    const timezone = normalizeIanaTimezone(input.timezone ?? profile.timezone);
    if (!timezone) throw new Error("timezone must be a valid IANA timezone");
    const timeOfDay = normalizeDailyTime(input.timeOfDay);
    const daysOfWeek = normalizeDaysOfWeek(input.daysOfWeek);
    const oneShot = input.oneShot ?? false;
    const existing = targetedSchedule ?? (process
      ? (await this.store.list(safeUserId)).find((schedule) => schedule.kind === "process" && schedule.processId === process.processId)
      : undefined);
    const generatedScheduleId = this.ids.scheduleId ?? randomIdGenerator.scheduleId!;
    return this.store.save(safeUserId, {
      id: existing?.id ?? (process ? dailyScheduleId(safeUserId, process.processId) : generatedScheduleId()),
      daysOfWeek,
      kind,
      ...action,
      oneShot,
      timeOfDay,
      timezone,
      enabled: true,
      nextFireAt: nextDailyFireAt({ after: this.clock.now(), timeOfDay, timezone, daysOfWeek }),
    });
  }

  async disableSchedule(userId: string, scheduleId: string): Promise<ProcessSchedule | null> {
    const safeUserId = assertUserId(userId);
    const existing = await this.store.get(safeUserId, scheduleId);
    if (!existing) return null;
    return this.store.save(safeUserId, {
      id: existing.id,
      daysOfWeek: existing.daysOfWeek,
      kind: existing.kind,
      ...(existing.processId === undefined ? {} : { processId: existing.processId }),
      ...(existing.reminderText === undefined ? {} : { reminderText: existing.reminderText }),
      oneShot: existing.oneShot,
      timeOfDay: existing.timeOfDay,
      timezone: existing.timezone,
      enabled: false,
      nextFireAt: existing.nextFireAt,
    });
  }
}

export class AssistantScheduleNotFoundError extends Error {
  constructor(readonly scheduleId: string) {
    super(`Assistant schedule not found: ${scheduleId}`);
    this.name = "AssistantScheduleNotFoundError";
  }
}

export class AssistantScheduleKindChangeError extends Error {
  constructor(readonly existingKind: ProcessSchedule["kind"], readonly requestedKind: ProcessSchedule["kind"]) {
    super(`Schedule kind cannot be changed from ${existingKind} to ${requestedKind}; disable it and create a new schedule instead.`);
    this.name = "AssistantScheduleKindChangeError";
  }
}

export class UnsupportedAssistantScheduleProcessError extends Error {
  constructor(readonly processId: string) {
    super(`Unsupported assistant schedule process: ${processId}`);
    this.name = "UnsupportedAssistantScheduleProcessError";
  }
}

function processAction(input: SaveDailyScheduleInput): { processId: AssistantDiagnosticProcessId } {
  const processId = input.processId ?? "";
  if (!isAssistantDiagnosticProcessId(processId)) throw new UnsupportedAssistantScheduleProcessError(processId);
  if (input.reminderText !== undefined) throw new Error("process schedule must not have reminderText");
  return { processId };
}

function reminderAction(input: SaveDailyScheduleInput): { reminderText: string } {
  if (input.processId !== undefined) throw new Error("reminder schedule must not have processId");
  const reminderText = input.reminderText?.trim() ?? "";
  if (!reminderText) throw new Error("reminderText is required for reminder schedules");
  return { reminderText };
}

function dailyScheduleId(userId: string, processId: AssistantDiagnosticProcessId): string {
  return `${userId}:${processId}-daily`;
}
