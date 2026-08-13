export type ScheduleFireStatus = "pending" | "succeeded" | "failed";
export type ScheduledActionKind = "process" | "reminder";

/** Durable daily schedule owned by one authenticated user. */
export type ProcessSchedule = {
  id: string;
  userId: string;
  daysOfWeek: number;
  kind: ScheduledActionKind;
  processId?: string;
  reminderText?: string;
  oneShot: boolean;
  timeOfDay: string;
  timezone: string;
  enabled: boolean;
  nextFireAt: string;
  createdAt: string;
  updatedAt: string;
};

/** Durable idempotency ledger entry for one scheduled occurrence. */
export type ScheduleFire = {
  scheduleId: string;
  userId: string;
  daysOfWeek: number;
  kind: ScheduledActionKind;
  processId?: string;
  reminderText?: string;
  oneShot: boolean;
  scheduledFor: string;
  status: ScheduleFireStatus;
  createdAt: string;
  completedAt?: string;
  errorCode?: string;
};
