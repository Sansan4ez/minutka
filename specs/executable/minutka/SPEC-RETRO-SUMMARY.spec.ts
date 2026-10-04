import { describe, expect, it } from "vitest";
import { RetrospectiveSummaryService } from "../../../src/application/retrospective-summary.js";
import { WeeklyActivitySummaryService } from "../../../src/application/weekly-activity-summary.js";
import { CycleActivitySummaryService } from "../../../src/application/cycle-activity-summary.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import type { WorkRetrospectiveEpisode, WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";

const now = "2026-08-26T12:00:00.000Z";
const scope = { employeeId: "employee_a", companyId: "company_a", groupId: "group_a", subjectKey: "00000000-0000-4000-8000-000000000001", threadId: "thread_a" };
const period = { start: "2026-08-18T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
const clock = { now: () => now };
const weekly = new WeeklyActivitySummaryService({ listOwnActivities: async () => [] }, clock);
const cycle = new CycleActivitySummaryService({ listOwnActivities: async () => [] }, clock);
const readWeek = () => weekly.summarize({ employeeId: scope.employeeId, timezone: "Etc/UTC" });
const readCycle = () => cycle.summarize({ employeeId: scope.employeeId, timezone: "Etc/UTC", period: { start: "2026-08-18", end: "2026-09-01" } });

async function fixture(consent = true) {
  const world = createInMemoryWorld(() => now);
  world.participants.push({ ...scope, status: "profile_completed", createdAt: period.start, updatedAt: now });
  const canonical = createInMemoryConversationStore(world);
  const store = createInMemoryWorkRetrospectiveStore(canonical);
  const episode: WorkRetrospectiveEpisode = {
    ...scope, episodeId: "old", period, methodVersion: "v1", messageRefs: [{ messageId: "message_old" }], activityRefs: [],
    statements: { actions: [], value: [], future: [], indicators: [] },
    selectedStep: { statementId: "step", text: "Попробую шаблон", kind: "intention", sourceRefs: [{ type: "message", messageId: "message_old" }] },
    indicator: { sign: "Меньше возвратов", meaning: "Поля заполнены", reaction: "Проверить шаблон", sourceRefs: [{ type: "message", messageId: "message_old" }] },
    followUpConsent: { granted: consent, sourceRef: { messageId: "message_old" } },
    status: "paused", revision: 0, questionBudget: { localDate: "2026-08-18", dailyDelivered: 0 },
  };
  const event: WorkRetrospectiveEvent = { ...scope, eventId: "selected", episodeId: "old", sourceMessageId: "message_old", ordinal: 0, version: 1, expectedRevision: 0, timestamp: period.start, action: { type: "episode_selected", episode } };
  expect(await store.appendTurnWithEvents({ scope, episodeId: "old", expectedRevision: 0, events: [event], turn: { ...scope, messageId: "message_old", userText: "Попробую шаблон", agentResponse: "Хорошо", timestamp: period.start } })).toMatchObject({ status: "applied" });
  for (let i = 0; i < 6; i++) await canonical.appendTurn({ ...scope, messageId: `recent${i}`, userText: "Другая работа", agentResponse: "Спасибо", timestamp: now });
  return { canonical, store, service: new RetrospectiveSummaryService(store) };
}

describe("personal retrospective summary", () => {
  it("SPEC-RETRO-SUMMARY-01 reads week-one step outside recent five during week two", async () => {
    const { canonical, service } = await fixture();
    expect((await canonical.getRecentTurns({ ...scope, limit: 5 })).some((t) => t.messageId === "message_old")).toBe(false);
    const result = await service.summarize({ scope, period }, readWeek);
    expect(result).toMatchObject({ status: "applied", value: { facts: { fromDate: "2026-08-20", toDate: "2026-08-26" }, episodePeriod: period, episodes: [{ followUp: { step: { text: "Попробую шаблон" }, indicator: { sign: "Меньше возвратов" }, question: expect.stringContaining("наблюдали") } }] } });
  });
  it("SPEC-RETRO-SUMMARY-02 no consent means no imposed follow-up", async () => {
    const { service } = await fixture(false);
    const result = await service.summarize({ scope, period }, readWeek);
    expect("value" in result && result.value.episodes[0]?.followUp).toBeUndefined();
  });
  it("SPEC-RETRO-SUMMARY-03 final keeps untried intention separate from outcomes", async () => {
    const { service } = await fixture();
    const result = await service.summarize({ scope, period }, readCycle);
    expect(result).toMatchObject({ value: { facts: { sufficientData: false, fromDate: "2026-08-18", toDate: "2026-08-26" }, episodes: [{ confirmed: [], tried: [], observations: [], intentions: [{ kind: "intention" }] }] } });
  });
  it("SPEC-RETRO-SUMMARY-04 preserves thin facts and excludes a different owner even from a faulty read port", async () => {
    const { store } = await fixture();
    const own = await store.readEpisodes({ scope, period, limit: 100 });
    if (!("value" in own)) throw new Error("fixture failed");
    const service = new RetrospectiveSummaryService({ readEpisodes: async () => ({ status: "applied", value: own.value.map((e) => ({ ...e, employeeId: "employee_other" })) }) });
    expect(await service.summarize({ scope, period }, readWeek)).toMatchObject({ value: { facts: { sufficientData: false, activityCount: 0, routines: [] }, episodes: [] } });
  });
  it("SPEC-RETRO-SUMMARY-05 eight-day-old discussion neither writes nor refreshes correction provenance", async () => {
    const { store, service, canonical } = await fixture();
    const before = await store.readEpisode({ scope, episodeId: "old" });
    const turns = await canonical.getRecentTurns({ ...scope, limit: 20 });
    const result = await service.summarize({ scope, period }, readWeek);
    expect(await store.readEpisode({ scope, episodeId: "old" })).toEqual(before);
    expect(await canonical.getRecentTurns({ ...scope, limit: 20 })).toEqual(turns);
    expect(turns.find((t) => t.messageId === "message_old")?.timestamp).toBe(period.start);
    expect(JSON.stringify(result)).not.toContain("correctionHandle");
  });
});
