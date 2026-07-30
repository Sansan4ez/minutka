export type ScheduleFireStatus = "pending" | "succeeded" | "failed";

/** Durable daily process schedule owned by one authenticated user. */
export type ProcessSchedule = {
  id: string;
  userId: string;
  processId: string;
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
  processId: string;
  scheduledFor: string;
  status: ScheduleFireStatus;
  createdAt: string;
  completedAt?: string;
  errorCode?: string;
};
