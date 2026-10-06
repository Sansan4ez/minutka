import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { conversationTurnOrigin } from "../../../src/application/conversation-store.js";
import type { WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";

import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { buildRetrospectiveContext } from "../../../src/application/work-retrospective-service.js";
import { ResearchCorpusExportService } from "../../../src/application/research-corpus-export.js";
import { retrospectiveMetadataFixture } from "../support/retrospective-metadata-fixture.js";
function fixture() {
  const data = retrospectiveMetadataFixture();
  const world = createInMemoryWorld(() => data.turn.timestamp);
  world.participants.push({ ...data.scope, status: "profile_completed", createdAt: data.turn.timestamp, updatedAt: data.turn.timestamp });
  return { ...data, world, store: createInMemoryConversationStore(world) };
}
const secretIndicator = {
  sign: ["sk", "SYNTHETIC_REVIEW_ONLY_123456789"].join("-"),
  meaning: "password=synthetic_review_only",
  reaction: "Bearer SYNTHETIC_REVIEW_ONLY",
};
function selectedFixture(indicator: typeof secretIndicator) {
  const data = fixture();
  data.turn.retrospectiveEvents = [{ ...data.event, action: { type: "episode_selected", episode: {
    ...data.scope, episodeId: data.event.episodeId,
    period: { start: "2026-08-26T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z" },
    methodVersion: "v1", messageRefs: [{ messageId: data.turn.messageId }], activityRefs: [],
    statements: { actions: [], value: [], future: [], indicators: [] },
    status: "active", revision: 0, questionBudget: { localDate: "2026-08-26", dailyDelivered: 0 },
    indicator: { ...indicator, sourceRefs: [{ type: "message", messageId: data.turn.messageId }] },
  } } }];
  return data;
}
function expectRedacted(value: unknown) {
  const json = JSON.stringify(value);
  // Boolean assertions avoid printing credential probes on failure.
  expect(Object.values(secretIndicator).every((raw) => !json.includes(raw))).toBe(true);
  expect(json.includes("[REDACTED]")).toBe(true);
}
async function exportedMetadata(data: ReturnType<typeof fixture>) {
  return new ResearchCorpusExportService({
    listSubjects: async () => [{ ...data.scope, evidenceRefs: [] }],
    listMessages: async () => [{ messageId: data.turn.messageId, subjectKey: data.scope.subjectKey,
      userText: data.turn.userText, agentResponse: data.turn.agentResponse, timestamp: data.turn.timestamp,
      metadata: data.world.messages[0]!.metadata! }],
    listActivities: async () => [], listFeedback: async () => [],
  }, { list: async () => [] }, { list: async () => [] }).export({ ...data.scope, format: "json" });
}
async function rebuiltContext(data: ReturnType<typeof fixture>) {
  const canonical = createInMemoryConversationStore(data.world);
  const result = await createInMemoryWorkRetrospectiveStore(canonical).readEpisode({
    scope: data.scope, episodeId: data.event.episodeId,
  });
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error("episode rebuild failed");
  const context = buildRetrospectiveContext(result.value);
  expect(context.status).toBe("applied");
  if (context.status !== "applied") throw new Error("context build failed");
  expect(context.value.length <= 6000).toBe(true);
  return { episode: result.value, context: JSON.parse(context.value) };
}
describe("canonical retrospective metadata", () => {
  it("SPEC-RETRO-SECRET-01 redacts indicator before append, rebuild, context and corpus export", async () => {
    const data = selectedFixture(secretIndicator);
    await data.store.appendTurn(data.turn);
    expectRedacted(data.world.messages[0]!.metadata);
    expectRedacted(await data.store.readEvents({ scope: data.scope, limit: 10 }));
    expectRedacted(await rebuiltContext(data));
    expectRedacted((await exportedMetadata(data)).corpus);
  });
  it("SPEC-RETRO-SECRET-02 preserves ordinary indicator, scope and refs; identical replay is inert", async () => {
    const indicator = { sign: "Меньше исправлений", meaning: "Шаблон помогает", reaction: "Продолжу использовать" };
    const data = selectedFixture(indicator);
    await data.store.appendTurn(data.turn);
    await createInMemoryConversationStore(data.world).appendTurn(structuredClone(data.turn));
    expect(data.world.messages).toHaveLength(1);
    expect(await data.store.getTurnByMessageId({ ...data.scope, messageId: data.turn.messageId })).toEqual(data.turn);
    expect((await rebuiltContext(data)).episode.indicator).toEqual({ ...indicator, sourceRefs: [{ type: "message", messageId: data.turn.messageId }] });
    expect(JSON.parse((await exportedMetadata(data)).content).messages[0].metadata).toEqual(data.world.messages[0]!.metadata);
  });
  it("SPEC-RETRO-SECRET-03 sanitizes raw legacy indicator on event read, rebuild and export", async () => {
    const data = selectedFixture(secretIndicator);
    await data.store.appendTurn(data.turn);
    // Simulate pre-fix durable metadata, not a production read or migration.
    data.world.messages[0]!.metadata!.retrospectiveEvents = structuredClone(data.turn.retrospectiveEvents);
    expectRedacted(await createInMemoryConversationStore(data.world).readEvents({ scope: data.scope, limit: 10 }));
    expectRedacted(await rebuiltContext(data));
    expectRedacted((await exportedMetadata(data)).corpus);
  });
  it("SPEC-RETRO-METADATA-01 round-trips after adapter recreation and reads scoped period events", async () => {
    const { world, store, turn, scope } = fixture();
    await store.appendTurn(turn);
    const restarted = createInMemoryConversationStore(world);
    expect(await restarted.getTurnByMessageId({ ...scope, messageId: "m1" })).toEqual(turn);
    expect(await restarted.readEvents({ scope, limit: 10, period: { start: turn.timestamp, end: turn.timestamp } })).toEqual(turn.retrospectiveEvents);
    expect(await restarted.readEvents({ scope: { ...scope, groupId: "other" }, limit: 10 })).toEqual([]);
    const read = await restarted.getRecentTurns({ ...scope, limit: 1 });
    read[0]!.retrospectiveEvents![0]!.eventId = "mutated";
    expect(await restarted.getTurnByMessageId({ ...scope, messageId: "m1" })).toEqual(turn);
  });
  it("SPEC-RETRO-METADATA-02 replays identical keys and rejects changed payloads including delivery", async () => {
    const { world, store, turn, scope, event } = fixture();
    await store.appendTurn(turn); await store.appendTurn(structuredClone(turn));
    await expect(store.appendTurn({ ...turn, userText: "different" })).rejects.toMatchObject({ code: "persistence_conflict" });
    expect(world.messages).toHaveLength(1);
    const delivery: WorkRetrospectiveEvent = { ...event, eventId: "delivery", ordinal: 2, action: { type: "response_delivery", responseMessageId: turn.messageId, questionId: "question_a", status: "failed", localDate: "2026-08-26" } };
    const request = { scope, sourceMessageId: "m1", events: [delivery] };
    await store.appendDeliveryEvents(request); await store.appendDeliveryEvents(request);
    await store.appendTurn(turn);
    expect(await store.readEvents({ scope, limit: 10 })).toHaveLength(3);
    await expect(store.appendDeliveryEvents({ ...request, events: [{ ...delivery, timestamp: "2026-08-26T13:00:00.000Z" }] })).rejects.toMatchObject({ code: "persistence_conflict" });
  });
  it("SPEC-RETRO-METADATA-03 invalid metadata leaves no turn or partial canonical events", async () => {
    const { world, store, turn, event, scope } = fixture();
    await expect(store.appendTurn({ ...turn, retrospectiveEvents: [event, { ...event, eventId: "bad", ordinal: 1, employeeId: "other" }] })).rejects.toMatchObject({ code: "persistence_conflict" });
    expect(world.messages).toHaveLength(0);
    expect(await store.readEvents({ scope, limit: 10 })).toEqual([]);
  });
  it("SPEC-RETRO-METADATA-04 legacy origin remains unknown and another owner cannot read", async () => {
    const { store, turn, scope } = fixture();
    const { origin: _, retrospectiveEvents: __, ...legacy } = turn;
    await store.appendTurn(legacy);
    const read = await store.getTurnByMessageId({ ...scope, messageId: "m1" });
    expect(read).toEqual(legacy); expect(conversationTurnOrigin(read!)).toBe("unknown");
    expect(await store.getTurnByMessageId({ ...scope, employeeId: "other", messageId: "m1" })).toBeUndefined();
  });
});
