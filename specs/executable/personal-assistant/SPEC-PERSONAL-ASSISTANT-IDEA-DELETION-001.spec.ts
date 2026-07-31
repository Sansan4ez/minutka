import { describe, expect, it } from "vitest";
import { IdeaDeletionService, pendingIdeaDeletionAction } from "../../../src/application/idea-deletion.js";
import { createInMemoryIdeaDeletionConfirmationStore } from "../../../src/application/in-memory-idea-deletion-confirmation-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createAssistantRecordsProjectionBuilder } from "../../../src/application/assistant-records-projection.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";

function setup() {
  let now = "2026-07-31T09:00:00.000Z";
  const clock = { now: () => now };
  const ideas = createInMemoryIdeaStore(clock);
  const world = createInMemoryWorld(clock.now);
  let sequence = 0;
  const confirmations = createInMemoryIdeaDeletionConfirmationStore(ideas);
  const service = new IdeaDeletionService(ideas, confirmations, clock, {
    confirmationId: () => `idea-delete-${++sequence}`,
    auditEventStore: createInMemoryAuditEventStore(world),
    idGenerator: { auditEventId: () => `idea-delete-audit-${++sequence}` },
  });
  return { service, ideas, world, setNow(value: string) { now = value; } };
}

async function addIdea(ideas: ReturnType<typeof createInMemoryIdeaStore>, id: string, summary: string, userId = "owner") {
  return ideas.add({ id, userId, project: "ASSISTANT", type: "knowledge", summary, status: "raw" });
}

describe("SPEC-PERSONAL-ASSISTANT-IDEA-DELETION-001: typed reversible idea deletion", () => {
  it("deletes the last captured exact candidate only after confirmation and hides it from /proc/records", async () => {
    const { service, ideas, world } = setup();
    await addIdea(ideas, "idea-1", "First note");
    const latest = await addIdea(ideas, "idea-2", "You wanted to go");

    const candidates = await service.search("owner", { query: "wanted to go" });
    expect(candidates.map(({ id }) => id)).toEqual(["idea-2"]);
    const proposed = await service.propose("owner", { ideaId: latest.id, expectedRevision: latest.revision, reason: "saved by mistake" });
    expect(proposed.status).toBe("needs_confirmation");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    expect(pendingIdeaDeletionAction(proposed.confirmation, proposed.idea)).toMatchObject({
      actionKind: "delete_idea", preview: { kind: "delete_idea", ideaId: { value: "idea-2" }, summary: { value: "You wanted to go" }, revision: 1 },
    });
    await expect(ideas.list("owner")).resolves.toHaveLength(2);
    await expect(service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "deleted" } });
    await expect(ideas.get("owner", "idea-2")).resolves.toBeNull();
    const projection = await createAssistantRecordsProjectionBuilder({ ideaStore: ideas, now: () => "2026-07-31T09:01:00.000Z" }).build({ userId: "owner", requestId: "request" });
    expect(projection.data.records.map(({ id }) => id)).toEqual(["idea-1"]);
    expect(JSON.stringify(world.auditEvents)).not.toContain("You wanted to go");
    expect(world.auditEvents.map(({ type, metadata }) => ({ type, metadata }))).toMatchObject([
      { type: "idea_deletion_proposed", metadata: { ideaId: "idea-2", recordType: "idea", result: "pending" } },
      { type: "idea_deletion_decided", metadata: { ideaId: "idea-2", recordType: "idea", result: "deleted" } },
    ]);
  });

  it("returns multiple deterministic candidates without deleting an ambiguous natural-language reference", async () => {
    const { service, ideas } = setup();
    await addIdea(ideas, "idea-a", "Launch partner meeting");
    await addIdea(ideas, "idea-b", "Launch content plan");

    await expect(service.search("owner", { query: "launch" })).resolves.toMatchObject([{ id: "idea-b" }, { id: "idea-a" }]);
    await expect(ideas.list("owner")).resolves.toHaveLength(2);
  });

  it("does not reveal another owner or an unknown id", async () => {
    const { service, ideas } = setup();
    const privateIdea = await addIdea(ideas, "private", "Secret", "other");
    await expect(service.propose("owner", { ideaId: privateIdea.id, expectedRevision: privateIdea.revision })).resolves.toEqual({ status: "not_found" });
    await expect(service.propose("owner", { ideaId: "missing", expectedRevision: 1 })).resolves.toEqual({ status: "not_found" });
    await expect(service.search("owner", { query: "Secret" })).resolves.toEqual([]);
  });

  it("keeps double delete and double undo idempotent while protecting concurrent updates", async () => {
    const { service, ideas } = setup();
    const captured = await addIdea(ideas, "idea-1", "Draft");
    const stale = await service.propose("owner", { ideaId: captured.id, expectedRevision: captured.revision });
    if (stale.status !== "needs_confirmation") throw new Error("expected confirmation");
    await ideas.update("owner", captured.id, { summary: "Updated draft" });
    await expect(service.confirm("owner", stale.confirmation.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "conflict", current: { revision: 2 } } });

    const current = await ideas.get("owner", captured.id);
    if (!current) throw new Error("expected current idea");
    const proposed = await service.propose("owner", { ideaId: current.id, expectedRevision: current.revision });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await expect(service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "deleted", idea: { revision: 3 } } });
    await expect(service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({ status: "already_confirmed", outcome: { outcome: "deleted", idea: { revision: 3 } } });
    await expect(service.undo("owner", { ideaId: current.id, expectedRevision: 3 })).resolves.toMatchObject({ outcome: "restored", idea: { revision: 4 } });
    await expect(service.undo("owner", { ideaId: current.id })).resolves.toMatchObject({ outcome: "unchanged", idea: { revision: 4 } });
  });

  it("restores the latest deletion through a restarted service sharing durable state", async () => {
    const { service, ideas, setNow } = setup();
    const captured = await addIdea(ideas, "idea-restart", "Restore after restart");
    const proposed = await service.propose("owner", { ideaId: captured.id, expectedRevision: captured.revision });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await service.confirm("owner", proposed.confirmation.confirmationId);
    setNow("2026-07-31T09:05:00.000Z");

    const restarted = new IdeaDeletionService(ideas, createInMemoryIdeaDeletionConfirmationStore(ideas), { now: () => "2026-07-31T09:05:00.000Z" });
    await expect(restarted.undo("owner")).resolves.toMatchObject({ outcome: "restored", idea: { id: "idea-restart" } });
    await expect(ideas.get("owner", "idea-restart")).resolves.toMatchObject({ summary: "Restore after restart", revision: 3 });
  });
});
