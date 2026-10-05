import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { conversationTurnOrigin } from "../../../src/application/conversation-store.js";
import type { WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";

import { retrospectiveMetadataFixture } from "../support/retrospective-metadata-fixture.js";
function fixture() {
  const data = retrospectiveMetadataFixture();
  const world = createInMemoryWorld(() => data.turn.timestamp);
  world.participants.push({ ...data.scope, status: "profile_completed", createdAt: data.turn.timestamp, updatedAt: data.turn.timestamp });
  return { ...data, world, store: createInMemoryConversationStore(world) };
}
describe("canonical retrospective metadata", () => {
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
