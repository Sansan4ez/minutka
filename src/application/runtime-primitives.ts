import { randomUUID } from "node:crypto";

export type Clock = { now(): string };

export type IdGenerator = {
  requestId(): string;
  messageId(): string;
  insightId(): string;
  feedbackId(): string;
  ideaId(): string;
  scheduleId?(): string;
  taskId?(): string;
  usageId?(): string;
  auditEventId(): string;
};

export const systemClock: Clock = { now: () => new Date().toISOString() };

export const randomIdGenerator: IdGenerator = {
  requestId: () => `req_${randomUUID()}`,
  messageId: () => `msg_${randomUUID()}`,
  insightId: () => `ins_${randomUUID()}`,
  feedbackId: () => `fb_${randomUUID()}`,
  ideaId: () => `idea_${randomUUID()}`,
  scheduleId: () => `schedule_${randomUUID()}`,
  taskId: () => `task_${randomUUID()}`,
  usageId: () => `usage_${randomUUID()}`,
  auditEventId: () => `evt_${randomUUID()}`,
};

/** Deterministic IDs are intentionally limited to executable specs. */
export function createDeterministicIdGenerator(): IdGenerator {
  const counters = { request: 0, message: 0, insight: 0, feedback: 0, idea: 0, schedule: 0, task: 0, usage: 0, audit: 0 };
  return {
    requestId: () => `req_${++counters.request}`,
    messageId: () => `msg_${++counters.message}`,
    insightId: () => `ins_${++counters.insight}`,
    feedbackId: () => `fb_${++counters.feedback}`,
    ideaId: () => `idea_${++counters.idea}`,
    scheduleId: () => `schedule_${++counters.schedule}`,
    taskId: () => `task_${++counters.task}`,
    usageId: () => `usage_${++counters.usage}`,
    auditEventId: () => `evt_${++counters.audit}`,
  };
}
