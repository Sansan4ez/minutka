import { describe, expect, it } from "vitest";
import { createAssistantRecordsProjectionBuilder, renderAssistantRecordsProjection } from "../../../src/application/assistant-records-projection.js";
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

  it("sets truncated when the record limit or rendered character budget is exceeded", async () => {
    let minute = 0;
    const store = createInMemoryIdeaStore({ now: () => `2026-07-15T09:${String(minute++).padStart(2, "0")}:00.000Z` });
    for (let index = 0; index < 25; index++) {
      await store.add({ id: `idea-${index}`, userId: "maxim", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "x".repeat(1_001), status: "raw" });
    }

    const projection = await createAssistantRecordsProjectionBuilder({ ideaStore: store, now: () => "2026-07-15T10:00:00.000Z" }).build({ userId: "maxim", requestId: "req-1" });
    expect(projection.data.truncated).toBe(true);
    expect(projection.data.records.length).toBeGreaterThan(0);
    expect(projection.data.records.length).toBeLessThan(12);
    expect(projection.data.records[0]).toMatchObject({ id: "idea-24", summary: expect.stringMatching(/^x{1000}$/) });
    expect(projection.data.records.map((record) => record.id)).not.toContain("idea-0");
    expect(Array.from(renderAssistantRecordsProjection(projection)).length).toBeLessThanOrEqual(12_000);
  });

  it("counts escaped ids, projects and Unicode in the exact rendered section", async () => {
    let minute = 0;
    const store = createInMemoryIdeaStore({ now: () => `2026-07-15T09:${String(minute++).padStart(2, "0")}:00.000Z` });
    for (let index = 0; index < 24; index++) {
      await store.add({
        id: `idea-${index}-<&\"😀`.repeat(20),
        userId: "maxim",
        project: `<&>\"😀`.repeat(200),
        type: "knowledge",
        summary: `summary <&>\" 😀 ${index}`,
        status: "raw",
      });
    }

    const projection = await createAssistantRecordsProjectionBuilder({ ideaStore: store, now: () => "2026-07-15T10:00:00.000Z" }).build({ userId: "maxim", requestId: "req-rendered" });
    const rendered = renderAssistantRecordsProjection(projection);
    expect(projection.data.truncated).toBe(true);
    expect(projection.data.records.length).toBeLessThan(24);
    expect(Array.from(rendered).length).toBeLessThanOrEqual(12_000);
    expect(rendered).toContain("&lt;&amp;&gt;&quot;😀");
  });
});
