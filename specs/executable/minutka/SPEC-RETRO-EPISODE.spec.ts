import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { buildRetrospectiveContext, projectRetrospectiveEvents, validateRetrospectiveCommand } from "../../../src/application/work-retrospective-service.js";
import type { WorkRetrospectiveEpisode, WorkRetrospectiveEvent, WorkRetrospectiveEventAction } from "../../../src/domain/work-retrospective.js";
export const scope = { employeeId: "employee_a", companyId: "company_a", groupId: "group_a", subjectKey: "00000000-0000-4000-8000-000000000001", threadId: "thread_a" };
export const episode: WorkRetrospectiveEpisode = { ...scope, episodeId: "episode", period: { start: "2026-08-26T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z" }, methodVersion: "v1", messageRefs: [{ messageId: "m1" }], activityRefs: [], statements: { actions: [], value: [], future: [], indicators: [] }, selectedStep: { statementId: "step", text: "Попробую шаблон", kind: "intention", sourceRefs: [{ type: "message", messageId: "m1" }] }, status: "active", revision: 0, questionBudget: { localDate: "2026-08-26", dailyDelivered: 0 } };
const event = (revision: number, action: WorkRetrospectiveEventAction): WorkRetrospectiveEvent => ({ ...scope, eventId: `event_${revision}`, episodeId: "episode", sourceMessageId: `m${revision}`, ordinal: 0, version: 1, expectedRevision: revision, timestamp: "2026-08-26T12:00:00.000Z", action });
const question = (revision: number) => ({ questionId: `q${revision}`, text: "Как?", sourceTurn: { messageId: `m${revision}` }, target: { episodeId: "episode", revision, stage: "actions" as const, sourceRefs: [{ type: "message" as const, messageId: "m1" }] } });
const apply = (events: WorkRetrospectiveEvent[], next: WorkRetrospectiveEvent) => validateRetrospectiveCommand({ scope, episodeId: "episode", expectedRevision: next.expectedRevision, events: [next] }, events);
function delivered(count: number, weekly = false) {
  const events = [event(0, { type: "episode_selected", episode })];
  if (weekly) events.push(event(1, { type: "weekly_session_started", sessionId: "weekly", consent: { granted: true, sourceRef: { messageId: "m1" } } }));
  for (let index = 0; index < count; index++) {
    const revision = events.length;
    events.push(event(revision, { type: "question_generated", question: question(revision) }));
    events.push(event(revision + 1, { type: "response_delivery", responseMessageId: `response${index}`, questionId: `q${revision}`, status: "delivered", localDate: "2026-08-26", ...(weekly ? { sessionId: "weekly" } : {}) }));
    events.push(event(revision + 2, { type: "question_closed", questionId: `q${revision}`, reason: "answered" }));
  }
  return events;
}
describe("bounded retrospective episodes", () => {
  it("adapter restart rebuilds canonical selection and replay without duplicate turns", async () => {
    const world = createInMemoryWorld(() => "2026-08-26T12:00:00.000Z");
    world.participants.push({ ...scope, status: "profile_completed", createdAt: "2026-08-26T12:00:00.000Z", updatedAt: "2026-08-26T12:00:00.000Z" });
    const canonical = createInMemoryConversationStore(world);
    const selected = event(0, { type: "episode_selected", episode });
    const input = { scope, episodeId: "episode", expectedRevision: 0, events: [selected], turn: { ...scope, messageId: "m0", userText: "Попробую шаблон", agentResponse: "Хорошо", timestamp: selected.timestamp } };
    expect(await createInMemoryWorkRetrospectiveStore(canonical).appendTurnWithEvents(input)).toMatchObject({ status: "applied" });
    const restarted = createInMemoryWorkRetrospectiveStore(createInMemoryConversationStore(world));
    expect(await restarted.readEpisode(input)).toMatchObject({ status: "applied", value: { revision: 1, selectedStep: episode.selectedStep } });
    expect(await restarted.appendTurnWithEvents(input)).toMatchObject({ status: "replayed" });
    expect(await canonical.getRecentTurns({ ...scope, limit: 10 })).toHaveLength(1);
  });
  it("SPEC-RETRO-EPISODE-01 replays daily delivered budget and accepts statements", () => {
    const events = structuredClone(delivered(4));
    expect(projectRetrospectiveEvents(events)[0]?.questionBudget.dailyDelivered).toBe(4);
    expect(apply(events, event(events.length, { type: "question_generated", question: question(events.length) }))).toMatchObject({ status: "failed" });
    expect(apply(events, event(events.length, { type: "episode_updated", episode }))).toMatchObject({ status: "applied", value: { questionBudget: { dailyDelivered: 4 } } });
  });
  it("SPEC-RETRO-EPISODE-02 weekly consent replaces daily, ninth denied", () => {
    const events = delivered(8, true);
    expect(apply(events, event(events.length, { type: "question_generated", question: question(events.length) }))).toMatchObject({ status: "failed" });
    expect(projectRetrospectiveEvents(events)[0]?.questionBudget.dailyDelivered).toBe(0);
  });
  it("SPEC-RETRO-EPISODE-03 topic/day closes pending without losing step", () => {
    const events = [event(0, { type: "episode_selected", episode }), event(1, { type: "question_generated", question: question(1) }), event(2, { type: "question_closed", questionId: "q1", reason: "topic_changed" }), event(3, { type: "question_closed", questionId: "q1", reason: "new_day", localDate: "2026-08-27" })];
    expect(projectRetrospectiveEvents(events)[0]).toMatchObject({ status: "paused", selectedStep: episode.selectedStep });
    expect(projectRetrospectiveEvents(events)[0]?.pendingQuestion).toBeUndefined();
  });
  it("SPEC-RETRO-EPISODE-04 mandatory 6001 characters rejects without mutations", () => {
    const events = [event(0, { type: "episode_selected", episode })];
    const large = { ...question(1), text: "x".repeat(6001) };
    expect(buildRetrospectiveContext({ ...episode, pendingQuestion: large })).toEqual({ status: "failed", code: "context_budget_error" });
    expect(apply(events, event(1, { type: "question_generated", question: large }))).toMatchObject({ code: "context_budget_error" });
    expect(events).toHaveLength(1);
  });
  it("SPEC-RETRO-EPISODE-05 wrong owner/stale revision leaves revision two", () => {
    const events = [event(0, { type: "episode_selected", episode }), event(1, { type: "episode_updated", episode })];
    expect(apply(events, event(1, { type: "episode_status_changed", status: "declined" }))).toEqual({ status: "stale" });
    expect(apply(events, { ...event(2, { type: "episode_status_changed", status: "declined" }), employeeId: "employee_b" })).toEqual({ status: "forbidden" });
    expect(projectRetrospectiveEvents(events)[0]?.revision).toBe(2);
  });
  it("failed delivery does not consume budget; duplicate source replay is inert", () => {
    const events = [event(0, { type: "episode_selected", episode }), event(1, { type: "question_generated", question: question(1) }), event(2, { type: "response_delivery", responseMessageId: "r", questionId: "q1", status: "failed", localDate: "2026-08-26" })];
    expect(projectRetrospectiveEvents(events)[0]?.questionBudget.dailyDelivered).toBe(0);
    expect(apply(events, events[1]!)).toMatchObject({ status: "replayed" });
  });
});
