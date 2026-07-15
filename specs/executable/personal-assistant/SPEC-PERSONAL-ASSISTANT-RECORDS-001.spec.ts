import { describe, expect, it } from "vitest";
import { createAssistantRecordsProjectionBuilder } from "../../../src/application/assistant-records-projection.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";

describe("SPEC-PERSONAL-ASSISTANT-RECORDS-001: bounded /proc/records", () => {
  it("returns only the authenticated owner's records", async () => {
    const store = createInMemoryIdeaStore({ now: () => "2026-07-15T09:00:00.000Z" });
    await store.add({ id: "mine", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: "Моя идея", status: "raw" });
    await store.add({ id: "other", userId: "other", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "Чужая идея", status: "raw" });

    const projection = await createAssistantRecordsProjectionBuilder({ ideaStore: store, now: () => "2026-07-15T10:00:00.000Z" }).build({ userId: "maxim", requestId: "req-1" });
    expect(projection).toMatchObject({ path: "/proc/records", scope: { userId: "maxim" }, data: { records: [{ id: "mine", summary: "Моя идея" }], truncated: false } });
    expect(JSON.stringify(projection)).not.toContain("Чужая идея");
  });

  it("sets truncated when the record limit or character budget is exceeded", async () => {
    const store = createInMemoryIdeaStore({ now: () => "2026-07-15T09:00:00.000Z" });
    for (let index = 0; index < 25; index++) {
      await store.add({ id: `idea-${index}`, userId: "maxim", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "x".repeat(1_001), status: "raw" });
    }

    const projection = await createAssistantRecordsProjectionBuilder({ ideaStore: store, now: () => "2026-07-15T10:00:00.000Z" }).build({ userId: "maxim", requestId: "req-1" });
    expect(projection.data.truncated).toBe(true);
    expect(projection.data.records).toHaveLength(12);
    expect(projection.data.records[0]?.summary).toHaveLength(1_000);
  });
});
