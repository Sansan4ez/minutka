import type { OnboardingStatus } from "../domain/employee.js";
import type { ActivityDurationBucket, ActivitySystem, TaskCategory } from "../domain/insights.js";
import { participantEngagement, type ParticipantEngagement } from "./participant-engagement.js";

export type PilotStatusParticipantSnapshot = {
  employeeId: string;
  companyId: string;
  companyName: string;
  groupId: string;
  groupName: string;
  periodFrom: string;
  periodToExclusive: string;
  roleName?: string;
  status: OnboardingStatus;
  lastTouchOn?: string;
  timezone?: string;
  messages: number;
  activities: number;
  traces: number;
  schedules: number;
  fires: number;
  failedFires: number;
};

export type PilotStatusActivity = {
  employee_id: string;
  task_category?: TaskCategory;
  system?: ActivitySystem;
  duration_bucket?: ActivityDurationBucket;
  obstacle_kind?: "routine_pattern" | "automation_candidate" | "energy_stress_marker";
  obstacle_value?: string;
  activity_date: string;
};

export type PilotStatusMessageDate = {
  employee_id: string;
  message_date: string;
  count: number;
};

export type PilotStatusSnapshot = {
  participants: PilotStatusParticipantSnapshot[];
  activities: PilotStatusActivity[];
  messagesByDate: PilotStatusMessageDate[];
  feedbackCount: number;
  traceCoveredMessages: number;
  /** Independent aggregate checks used to detect projection/query drift. */
  controlTotals: { participants: number; messages: number; activities: number; traces: number };
};

export type PilotStatusStore = {
  /** Internal operator read. Implementations must select metadata only, never message/profile text or transport identity. */
  loadSnapshot(): Promise<PilotStatusSnapshot>;
};

export type PilotStatusOperationalHealth = {
  healthz: "ok" | "failed";
  pendingMigrations: number;
  server: {
    commit?: string;
    backupId?: string;
    smoke?: string;
    units: Array<{ name: string; status: string }>;
  };
};

export type PilotStatusFlag = {
  code: "coverage_below_60" | "system_other_above_40" | "obstacle_other_above_40" | "participant_dropped_off";
  severity: "warning" | "critical";
  label: string;
  detail: string;
};

export type PilotStatusData = {
  schemaVersion: "minutka-pilot-status/v1";
  generatedAt: string;
  period: { from: string | null; toExclusive: string | null; day: number; totalDays: number };
  participants: Array<{
    id: string;
    companyId: string;
    companyName: string;
    groupId: string;
    groupName: string;
    role: string | null;
    status: OnboardingStatus;
    engagement: ParticipantEngagement | "not_onboarded";
    lastTouch: string | null;
    messages: number;
    activities: number;
    traces: number;
    schedules: number;
    fires: number;
    failedFires: number;
  }>;
  activities: PilotStatusActivity[];
  messagesByDate: PilotStatusMessageDate[];
  dates: string[];
  metrics: {
    coveragePercent: number;
    systemOtherPercent: number;
    obstacleOtherPercent: number;
  };
  flags: PilotStatusFlag[];
  health: PilotStatusOperationalHealth & {
    firesSucceeded: number;
    firesFailed: number;
    feedbackCount: number;
    traceCoverage: { messages: number; traces: number; coveredMessages: number };
  };
};

/** Typed internal read used only for the operator/methodologist pilot-status artifact. */
export class PilotStatusService {
  constructor(
    private readonly store: PilotStatusStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async generate(operational: PilotStatusOperationalHealth): Promise<PilotStatusData> {
    const generatedAt = this.now();
    const snapshot = await this.store.loadSnapshot();
    const period = pilotPeriod(snapshot.participants, generatedAt);
    assertControlTotals(snapshot);
    const participants = snapshot.participants.map((participant) => ({
      id: participant.employeeId,
      companyId: participant.companyId,
      companyName: participant.companyName,
      groupId: participant.groupId,
      groupName: participant.groupName,
      role: participant.roleName ?? null,
      status: participant.status,
      engagement: participant.status === "profile_completed" && participant.timezone
        ? participantEngagement({ lastTouchOn: participant.lastTouchOn, now: generatedAt, timezone: participant.timezone })
        : "not_onboarded" as const,
      lastTouch: participant.lastTouchOn ?? null,
      messages: participant.messages,
      activities: participant.activities,
      traces: participant.traces,
      schedules: participant.schedules,
      fires: participant.fires,
      failedFires: participant.failedFires,
    }));
    const coveragePercent = percent(participants.filter((participant) => participant.status === "profile_completed").length, participants.length);
    const systemOtherPercent = percent(snapshot.activities.filter((activity) => activity.system === "other").length, snapshot.activities.length);
    const obstacleOtherPercent = percent(snapshot.activities.filter((activity) => activity.obstacle_value === "other").length, snapshot.activities.length);
    const metrics = { coveragePercent, systemOtherPercent, obstacleOtherPercent };
    const totalMessages = participants.reduce((sum, participant) => sum + participant.messages, 0);
    const totalTraces = participants.reduce((sum, participant) => sum + participant.traces, 0);
    const firesFailed = participants.reduce((sum, participant) => sum + participant.failedFires, 0);
    const fires = participants.reduce((sum, participant) => sum + participant.fires, 0);

    return {
      schemaVersion: "minutka-pilot-status/v1",
      generatedAt,
      period,
      participants,
      activities: snapshot.activities,
      messagesByDate: snapshot.messagesByDate,
      dates: calendarDates(period.from, period.toExclusive, generatedAt),
      metrics,
      flags: pilotStatusFlags({ day: period.day, participants, metrics }),
      health: {
        ...operational,
        firesSucceeded: Math.max(0, fires - firesFailed),
        firesFailed,
        feedbackCount: snapshot.feedbackCount,
        traceCoverage: { messages: totalMessages, traces: totalTraces, coveredMessages: snapshot.traceCoveredMessages },
      },
    };
  }
}

export function pilotStatusFlags(input: {
  day: number;
  participants: PilotStatusData["participants"];
  metrics: PilotStatusData["metrics"];
}): PilotStatusFlag[] {
  const flags: PilotStatusFlag[] = [];
  if (input.day >= 5 && input.metrics.coveragePercent < 60) {
    flags.push({ code: "coverage_below_60", severity: "critical", label: "Охват ниже 60%", detail: `День ${input.day}: профиль завершили ${input.metrics.coveragePercent}% участников.` });
  }
  if (input.day >= 7 && input.metrics.systemOtherPercent > 40) {
    flags.push({ code: "system_other_above_40", severity: "warning", label: "Слишком много system=other", detail: `Доля «прочего» в системах — ${input.metrics.systemOtherPercent}%.` });
  }
  if (input.day >= 7 && input.metrics.obstacleOtherPercent > 40) {
    flags.push({ code: "obstacle_other_above_40", severity: "warning", label: "Слишком много obstacle=other", detail: `Доля «прочего» в затруднениях — ${input.metrics.obstacleOtherPercent}%.` });
  }
  const droppedOff = input.participants.filter((participant) => participant.engagement === "dropped_off").map((participant) => participant.id);
  if (droppedOff.length) {
    flags.push({ code: "participant_dropped_off", severity: "critical", label: "Есть dropped_off", detail: droppedOff.join(", ") });
  }
  return flags;
}

function pilotPeriod(participants: PilotStatusParticipantSnapshot[], generatedAt: string): PilotStatusData["period"] {
  if (!participants.length) return { from: null, toExclusive: null, day: 0, totalDays: 0 };
  const from = participants.map((participant) => participant.periodFrom).sort()[0]!;
  const toExclusive = participants.map((participant) => participant.periodToExclusive).sort().at(-1)!;
  const generatedDate = generatedAt.slice(0, 10);
  return {
    from,
    toExclusive,
    day: Math.max(1, Math.min(daysBetween(from, toExclusive), daysBetween(from, generatedDate) + 1)),
    totalDays: daysBetween(from, toExclusive),
  };
}

function calendarDates(from: string | null, toExclusive: string | null, generatedAt: string): string[] {
  if (!from || !toExclusive) return [];
  const end = [generatedAt.slice(0, 10), previousDate(toExclusive)].sort()[0]!;
  if (end < from) return [];
  return Array.from({ length: daysBetween(from, end) + 1 }, (_, index) => addDays(from, index));
}

function assertControlTotals(snapshot: PilotStatusSnapshot): void {
  const projected = {
    participants: snapshot.participants.length,
    messages: snapshot.participants.reduce((sum, participant) => sum + participant.messages, 0),
    activities: snapshot.participants.reduce((sum, participant) => sum + participant.activities, 0),
    traces: snapshot.participants.reduce((sum, participant) => sum + participant.traces, 0),
  };
  for (const key of Object.keys(projected) as Array<keyof typeof projected>) {
    if (projected[key] !== snapshot.controlTotals[key]) {
      throw new Error(`pilot-status aggregate mismatch for ${key}: projected=${projected[key]} control=${snapshot.controlTotals[key]}`);
    }
  }
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round(value / total * 100);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateOrdinal(to) - dateOrdinal(from)) / 86_400_000);
}

function previousDate(value: string): string { return addDays(value, -1); }
function addDays(value: string, days: number): string { return new Date(dateOrdinal(value) + days * 86_400_000).toISOString().slice(0, 10); }
function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}
