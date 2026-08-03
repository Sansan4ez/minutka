import { describe, expect, it, vi } from "vitest";
import {
  contextDocumentPayloadDigest,
  ContextDocumentService,
  type ContextDocumentConfirmationStore,
  type PendingContextDocumentMutation,
} from "../../../src/application/context-document-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryContextDocumentConfirmationStore } from "../../../src/application/in-memory-context-document-confirmation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { contextDocumentDecisionResponseSchema } from "../../../src/contracts/minutka-api.js";

function harness() {
  let now = "2026-08-02T10:00:00.000Z";
  let confirmation = 0;
  const clock = { now: () => now };
  const documents = createInMemoryDocumentStore(clock);
  const world = createInMemoryWorld(clock.now);
  const service = new ContextDocumentService(documents, createInMemoryContextDocumentConfirmationStore(), clock, {
    confirmationId: () => `context-confirmation-${++confirmation}`,
    auditEventStore: createInMemoryAuditEventStore(world),
    idGenerator: createDeterministicIdGenerator(),
  });
  return { documents, service, world, setNow(value: string) { now = value; } };
}

async function seed(h: ReturnType<typeof harness>, owner = "owner", path = "context/00_inbox/source.md", content = "# Source\n\nold text") {
  return h.documents.put(owner, path, content);
}

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-DOCUMENT-MUTATIONS-001: safe typed Markdown mutations", () => {
  it("creates owner-scoped inbox notes once without overwriting canonical or legacy aliases", async () => {
    const h = harness();
    const created = await h.service.createNote("owner", { title: "Meeting Notes", content: "first" });
    expect(created).toMatchObject({ outcome: "created", path: "/proc/context/00_inbox/meeting-notes.md" });
    await expect(h.service.createNote("owner", { title: "Meeting Notes", content: "replacement" })).resolves.toMatchObject({ outcome: "conflict" });
    await h.documents.put("owner", "context/imported-knowledge-base/00_inbox/legacy.md", "legacy");
    await expect(h.service.createNote("owner", { title: "Legacy", content: "replacement" })).resolves.toMatchObject({ outcome: "conflict" });
    await expect(h.service.createNote("other", { title: "Meeting Notes", content: "other" })).resolves.toMatchObject({ outcome: "created" });
    await expect(h.service.createNote("owner", { title: "Unsafe", content: "body", destination: "99_system" })).rejects.toThrow("allow-listed context section");
    await expect(h.service.createNote("owner", { title: "Unsafe", content: "body", destination: "new_namespace" })).rejects.toThrow("allow-listed context section");
    await expect(h.documents.get("owner", "context/00_inbox/meeting-notes.md")).resolves.toMatchObject({ content: "first" });
  });

  it("confirms updates accepted under a configured limit above the default", async () => {
    const clock = { now: () => "2026-08-02T10:00:00.000Z" };
    const documents = createInMemoryDocumentStore(clock);
    const service = new ContextDocumentService(documents, createInMemoryContextDocumentConfirmationStore(), clock, {
      maximumDocumentBytes: 512 * 1024,
      confirmationId: () => "context-confirmation-large",
    });
    const original = await documents.put("owner", "context/00_inbox/source.md", "old text");
    const replacement = "x".repeat(300 * 1024);

    const proposed = await service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement,
    });
    expect(proposed.status).toBe("needs_confirmation");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await expect(service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({
      status: "confirmed", outcome: { outcome: "updated", path: "/proc/context/00_inbox/source.md" },
    });
    await expect(documents.get("owner", original.path)).resolves.toMatchObject({ content: replacement });
  });

  it("rejects content above the configured limit before proposal storage", async () => {
    const clock = { now: () => "2026-08-02T10:00:00.000Z" };
    const documents = createInMemoryDocumentStore(clock);
    const confirmations = createInMemoryContextDocumentConfirmationStore();
    const save = vi.spyOn(confirmations, "save");
    const service = new ContextDocumentService(documents, confirmations, clock, {
      maximumDocumentBytes: 16,
      confirmationId: () => "context-confirmation-too-large",
    });
    const original = await documents.put("owner", "context/00_inbox/source.md", "old text");
    const oversized = "x".repeat(17);

    await expect(service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement: oversized,
    })).rejects.toThrow("exceeds the 16-byte context document maximum");
    await expect(service.createNote("owner", { title: "Oversized", content: oversized })).rejects.toThrow(
      "exceeds the 16-byte context document maximum",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("still rejects a tampered stored proposal with an unchanged digest", async () => {
    let stored: PendingContextDocumentMutation | undefined;
    const confirmations: ContextDocumentConfirmationStore = {
      async save(record) {
        stored = {
          ...record,
          proposal: record.proposal.kind === "update"
            ? { ...record.proposal, content: `${record.proposal.content} tampered` }
            : record.proposal,
        };
      },
      async decide(_input, effect) {
        if (!stored) return { result: { status: "not_found" } };
        if (contextDocumentPayloadDigest(stored.proposal) !== stored.payloadDigest) {
          return { result: { status: "invalid_payload" }, proposal: stored.proposal };
        }
        return { result: { status: "confirmed", outcome: await effect(stored.proposal) }, proposal: stored.proposal };
      },
      async purge() { return 0; },
    };
    const clock = { now: () => "2026-08-02T10:00:00.000Z" };
    const documents = createInMemoryDocumentStore(clock);
    const service = new ContextDocumentService(documents, confirmations, clock, {
      confirmationId: () => "context-confirmation-tampered",
    });
    const original = await documents.put("owner", "context/00_inbox/source.md", "old text");
    const proposed = await service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement: "new text",
    });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");

    await expect(service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toEqual({ status: "invalid_payload" });
    await expect(documents.get("owner", original.path)).resolves.toMatchObject({ content: "old text" });
  });

  it("does not mutate before confirmation and enforces owner-bound exact-once decisions", async () => {
    const h = harness();
    const original = await seed(h);
    const proposed = await h.service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/source.md",
      expectedVersion: original.version,
      patch: { search: "old text", replacement: "new text" },
    });
    expect(proposed.status).toBe("needs_confirmation");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    expect(proposed.confirmation.preview.change).toMatchObject({
      removed: { value: "- old text", truncated: false },
      added: { value: "+ new text", truncated: false },
    });
    await expect(h.documents.get("owner", original.path)).resolves.toMatchObject({ content: "# Source\n\nold text" });
    await expect(h.service.confirm("other", proposed.confirmation.confirmationId)).resolves.toEqual({ status: "owner_mismatch" });
    const [first, second] = await Promise.all([
      h.service.confirm("owner", proposed.confirmation.confirmationId),
      h.service.confirm("owner", proposed.confirmation.confirmationId),
    ]);
    expect(first.status === "confirmed" || second.status === "confirmed").toBe(true);
    expect(first.status === "already_confirmed" || second.status === "already_confirmed").toBe(true);
    await expect(h.documents.get("owner", original.path)).resolves.toMatchObject({ content: "# Source\n\nnew text" });
  });

  it("bounds removed and added preview text independently for large rewrites", async () => {
    const h = harness();
    const originalContent = Array.from({ length: 300 }, (_, index) => `old line ${index}`).join("\n");
    const replacementContent = Array.from({ length: 300 }, (_, index) => `new line ${index}`).join("\n");
    const original = await seed(h, "owner", "context/00_inbox/source.md", originalContent);

    const proposed = await h.service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement: replacementContent,
    });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    const change = proposed.confirmation.preview.change;
    if (!change) throw new Error("expected change preview");

    expect(change.removed.value).toContain("old line");
    expect(change.added.value).toContain("new line");
    expect([...change.removed.value]).toHaveLength(280);
    expect([...change.added.value]).toHaveLength(280);
    expect(change.removed.truncated).toBe(true);
    expect(change.added.truncated).toBe(true);
  });

  it("represents pure additions and removals without borrowing the other side's preview budget", async () => {
    const h = harness();
    const additionSource = await seed(h, "owner", "context/00_inbox/addition.md", "kept");
    const addition = await h.service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/addition.md", expectedVersion: additionSource.version, replacement: "kept\nadded",
    });
    if (addition.status !== "needs_confirmation") throw new Error("expected confirmation");
    expect(addition.confirmation.preview.change).toEqual({
      removed: { value: "", truncated: false },
      added: { value: "+ added", truncated: false },
    });

    const removalSource = await seed(h, "owner", "context/00_inbox/removal.md", "kept\nremoved");
    const removal = await h.service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/removal.md", expectedVersion: removalSource.version, replacement: "kept",
    });
    if (removal.status !== "needs_confirmation") throw new Error("expected confirmation");
    expect(removal.confirmation.preview.change).toEqual({
      removed: { value: "- removed", truncated: false },
      added: { value: "", truncated: false },
    });
  });

  it("returns a stale-version conflict without writing and keeps rejection final", async () => {
    const h = harness();
    const original = await seed(h);
    const proposed = await h.service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement: "replacement",
    });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    const external = await h.documents.put("owner", original.path, "newer");
    await expect(h.service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toEqual({
      status: "confirmed", outcome: { outcome: "conflict", path: "/proc/context/00_inbox/source.md", currentVersion: external.version },
    });
    await expect(h.documents.get("owner", original.path)).resolves.toMatchObject({ content: "newer", version: external.version });

    const rejected = await h.service.proposeDelete("owner", { path: "/proc/context/00_inbox/source.md", expectedVersion: external.version });
    if (rejected.status !== "needs_confirmation") throw new Error("expected confirmation");
    await expect(h.service.reject("owner", rejected.confirmation.confirmationId)).resolves.toEqual({ status: "rejected" });
    await expect(h.service.confirm("owner", rejected.confirmation.confirmationId)).resolves.toEqual({ status: "already_rejected" });
    await expect(h.documents.get("owner", original.path)).resolves.toMatchObject({ content: "newer" });
  });

  it("reconciles uncertain post-write update and move retries into stable outcomes", async () => {
    const h = harness();
    const original = await seed(h);
    const update = await h.service.proposeUpdate("owner", { path: "/proc/context/00_inbox/source.md", expectedVersion: original.version, replacement: "replacement" });
    if (update.status !== "needs_confirmation") throw new Error("expected confirmation");
    await h.documents.put("owner", original.path, "replacement");
    await expect(h.service.confirm("owner", update.confirmation.confirmationId)).resolves.toMatchObject({
      status: "confirmed", outcome: { outcome: "updated", path: "/proc/context/00_inbox/source.md" },
    });

    const source = await h.documents.put("owner", "context/00_inbox/move-source.md", "move body");
    const move = await h.service.proposeMove("owner", { path: "/proc/context/00_inbox/move-source.md", destination: "/proc/context/00_inbox/move-destination.md", expectedVersion: source.version });
    if (move.status !== "needs_confirmation") throw new Error("expected confirmation");
    await h.documents.put("owner", "context/00_inbox/move-destination.md", source.content);
    await h.documents.delete("owner", source.path);
    await expect(h.service.confirm("owner", move.confirmation.confirmationId)).resolves.toMatchObject({
      status: "confirmed",
      outcome: {
        outcome: "moved",
        sourcePath: "/proc/context/00_inbox/move-source.md",
        destinationPath: "/proc/context/00_inbox/move-destination.md",
      },
    });
  });

  it("returns handles for not-found and destination-conflict outcomes", async () => {
    const h = harness();
    const updateSource = await seed(h, "owner", "context/00_inbox/missing-before-confirm.md");
    const update = await h.service.proposeUpdate("owner", {
      path: "/proc/context/00_inbox/missing-before-confirm.md",
      expectedVersion: updateSource.version,
      replacement: "replacement",
    });
    if (update.status !== "needs_confirmation") throw new Error("expected confirmation");
    await h.documents.delete("owner", updateSource.path);
    await expect(h.service.confirm("owner", update.confirmation.confirmationId)).resolves.toEqual({
      status: "confirmed",
      outcome: { outcome: "not_found", path: "/proc/context/00_inbox/missing-before-confirm.md" },
    });

    const moveSource = await seed(h, "owner", "context/00_inbox/racing-move.md");
    const move = await h.service.proposeMove("owner", {
      path: "/proc/context/00_inbox/racing-move.md",
      destination: "/proc/context/10_user_memory/racing-destination.md",
      expectedVersion: moveSource.version,
    });
    if (move.status !== "needs_confirmation") throw new Error("expected confirmation");
    const occupied = await h.documents.put("owner", "context/10_user_memory/racing-destination.md", "occupied");
    await expect(h.service.confirm("owner", move.confirmation.confirmationId)).resolves.toEqual({
      status: "confirmed",
      outcome: {
        outcome: "destination_conflict",
        path: "/proc/context/10_user_memory/racing-destination.md",
        currentVersion: occupied.version,
      },
    });
  });

  it("moves without two canonical copies and rejects occupied destinations", async () => {
    const h = harness();
    const original = await seed(h);
    await h.documents.put("owner", "context/00_inbox/occupied.md", "occupied");
    await expect(h.service.proposeMove("owner", {
      path: "/proc/context/00_inbox/source.md", destination: "/proc/context/00_inbox/occupied.md", expectedVersion: original.version,
    })).resolves.toMatchObject({ status: "destination_conflict" });
    const proposed = await h.service.proposeMove("owner", {
      path: "/proc/context/00_inbox/source.md", destination: "/proc/context/10_user_memory/moved.md", expectedVersion: original.version,
    });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await expect(h.service.confirm("owner", proposed.confirmation.confirmationId)).resolves.toMatchObject({
      status: "confirmed",
      outcome: {
        outcome: "moved",
        sourcePath: "/proc/context/00_inbox/source.md",
        destinationPath: "/proc/context/10_user_memory/moved.md",
      },
    });
    await expect(h.documents.get("owner", original.path)).resolves.toBeNull();
    await expect(h.documents.get("owner", "context/10_user_memory/moved.md")).resolves.toMatchObject({ content: original.content });
  });

  it("deletes and restores a selected version only inside the authenticated owner scope", async () => {
    const h = harness();
    const owner = await seed(h);
    await seed(h, "other", owner.path, "other private body");
    const proposed = await h.service.proposeDelete("owner", { path: "/proc/context/00_inbox/source.md", expectedVersion: owner.version });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    const deleted = await h.service.confirm("owner", proposed.confirmation.confirmationId);
    expect(deleted).toEqual({ status: "confirmed", outcome: { outcome: "deleted", path: "/proc/context/00_inbox/source.md", restoreVersion: owner.version } });
    await expect(h.documents.get("owner", owner.path)).resolves.toBeNull();
    await expect(h.documents.get("other", owner.path)).resolves.toMatchObject({ content: "other private body" });
    await expect(h.service.restoreVersion("other", { path: "/proc/context/00_inbox/source.md", version: owner.version })).resolves.toMatchObject({ outcome: "not_found" });
    await expect(h.service.restoreVersion("owner", { path: "/proc/context/00_inbox/source.md", version: owner.version })).resolves.toMatchObject({ outcome: "restored" });
    await expect(h.documents.get("owner", owner.path)).resolves.toMatchObject({ content: owner.content });
  });

  it("rejects storage paths in every mutation outcome contract shape", () => {
    const invalidOutcomes = [
      { outcome: "updated", path: "context/source.md", version: "v1" },
      { outcome: "moved", sourcePath: "context/source.md", destinationPath: "/proc/context/destination.md", version: "v2", sourceVersion: "v1" },
      { outcome: "deleted", path: "context/source.md", restoreVersion: "v1" },
      { outcome: "not_found", path: "context/source.md" },
      { outcome: "conflict", path: "context/source.md", currentVersion: "v2" },
      { outcome: "destination_conflict", path: "context/destination.md", currentVersion: "v2" },
    ];

    for (const outcome of invalidOutcomes) {
      expect(contextDocumentDecisionResponseSchema.safeParse({ status: "confirmed", outcome }).success).toBe(false);
    }
  });

  it("accepts only /proc/context Markdown handles and writes metadata-only audit records", async () => {
    const h = harness();
    const original = await seed(h, "owner", "context/private.md", "secret body");
    await expect(h.service.proposeDelete("owner", { path: "context/private.md", expectedVersion: original.version })).rejects.toThrow("/proc/context/");
    await expect(h.service.proposeDelete("owner", { path: "/proc/context/private.txt", expectedVersion: original.version })).rejects.toThrow("Markdown");
    const proposed = await h.service.proposeUpdate("owner", { path: "/proc/context/private.md", expectedVersion: original.version, replacement: "replacement secret" }, { requestId: "req-context" });
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await h.service.confirm("owner", proposed.confirmation.confirmationId, { requestId: "req-context" });
    const serialized = JSON.stringify(h.world.auditEvents.filter((event) => event.requestId === "req-context"));
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("replacement secret");
    expect(h.world.auditEvents.filter((event) => event.requestId === "req-context").every((event) => event.type === "context_document_mutated")).toBe(true);
  });
});
