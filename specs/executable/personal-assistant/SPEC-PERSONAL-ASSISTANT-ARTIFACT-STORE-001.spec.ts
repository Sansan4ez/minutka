import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArtifactGlobalCapacityExceededError, ArtifactOwnerQuotaExceededError } from "../../../src/application/artifact-capacity.js";
import { ArtifactSaveTimeoutError, ArtifactTooLargeError } from "../../../src/application/artifact-body-stager.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";

const clock = { now: () => "2026-07-15T00:00:00.000Z" };

function createStore(overrides?: {
  maximumBytes?: number;
  timeoutMs?: number;
  ownerSoftQuotaBytes?: number;
  ownerHardQuotaBytes?: number;
  globalHardQuotaBytes?: number;
  warnings?: unknown[];
}) {
  const contentStore = createInMemoryArtifactContentStore(clock);
  const store = createInMemoryArtifactStore({
    contentStore,
    clock,
    limits: { maximumBytes: overrides?.maximumBytes ?? 1024, timeoutMs: overrides?.timeoutMs ?? 1_000 },
    capacityPolicy: {
      ownerSoftQuotaBytes: overrides?.ownerSoftQuotaBytes ?? 2048,
      ownerHardQuotaBytes: overrides?.ownerHardQuotaBytes ?? 4096,
      globalHardQuotaBytes: overrides?.globalHardQuotaBytes ?? 8192,
    },
    onCapacityWarning: (warning) => overrides?.warnings?.push(warning),
  });
  return { store, contentStore };
}

function saveInput(input: { ownerId?: string; artifactId: string; deliveryKey: string; fileName: string; bytes?: string; stream?: () => Readable; size?: number }) {
  const bytes = Buffer.from(input.bytes ?? "same bytes");
  return {
    ownerId: input.ownerId ?? "owner-a",
    artifactId: input.artifactId,
    originalFileName: input.fileName,
    declaredMediaType: "text/plain",
    source: { kind: "http_upload" as const, deliveryKey: input.deliveryKey },
    body: { size: input.size ?? bytes.byteLength, openStream: input.stream ?? (() => Readable.from(bytes)) },
  };
}

describe("SPEC-PERSONAL-ASSISTANT-ARTIFACT-STORE-001: owner-scoped durable CAS", () => {
  it("deduplicates same bytes for one owner regardless of filename and keeps owners isolated", async () => {
    const { store, contentStore } = createStore();
    const first = await store.save(saveInput({ artifactId: "artifact-1", deliveryKey: "delivery-1", fileName: "first.txt" }));
    const second = await store.save(saveInput({ artifactId: "artifact-2", deliveryKey: "delivery-2", fileName: "renamed.txt" }));
    const other = await store.save(saveInput({ ownerId: "owner-b", artifactId: "artifact-3", deliveryKey: "delivery-1", fileName: "first.txt" }));

    expect(first.artifact.contentDigest).toHaveLength(64);
    expect(first.artifact.contentDigest).toBe(second.artifact.contentDigest);
    expect(first.contentDisposition).toBe("stored");
    expect(second.contentDisposition).toBe("reused");
    expect(other.contentDisposition).toBe("stored");
    await expect(contentStore.stat("owner-a", first.artifact.contentDigest)).resolves.toMatchObject({ ownerId: "owner-a", size: 10 });
    await expect(contentStore.stat("owner-b", first.artifact.contentDigest)).resolves.toMatchObject({ ownerId: "owner-b", size: 10 });
    await expect(store.get("owner-b", "artifact-1")).resolves.toBeNull();
  });

  it("is idempotent for delivery retries and parallel retries", async () => {
    const { store } = createStore();
    const input = saveInput({ artifactId: "artifact-1", deliveryKey: "retry-1", fileName: "note.txt" });
    const [first, second] = await Promise.all([store.save(input), store.save({ ...input, artifactId: "artifact-retry" })]);
    expect([first.deliveryDisposition, second.deliveryDisposition].sort()).toEqual(["created", "duplicate_delivery"]);
    expect(first.artifact.artifactId).toBe(second.artifact.artifactId);
    await expect(store.list("owner-a")).resolves.toHaveLength(1);
  });

  it("rejects oversize before reading and while streaming without publishing a reference", async () => {
    const { store } = createStore({ maximumBytes: 5 });
    let opened = false;
    await expect(store.save(saveInput({ artifactId: "known-large", deliveryKey: "large-1", fileName: "large", size: 6, stream: () => { opened = true; return Readable.from("123456"); } }))).rejects.toBeInstanceOf(ArtifactTooLargeError);
    expect(opened).toBe(false);
    await expect(store.save(saveInput({ artifactId: "stream-large", deliveryKey: "large-2", fileName: "large", size: 5, stream: () => Readable.from(["123", "456"]) }))).rejects.toBeInstanceOf(ArtifactTooLargeError);
    await expect(store.list("owner-a")).resolves.toEqual([]);
  });

  it("checks known-size quota before opening a stream and keeps owner usage isolated", async () => {
    const { store } = createStore({ ownerSoftQuotaBytes: 5, ownerHardQuotaBytes: 10, globalHardQuotaBytes: 20 });
    await store.save(saveInput({ ownerId: "owner-a", artifactId: "a-1", deliveryKey: "a-1", fileName: "a", bytes: "123456" }));
    await expect(store.checkCapacity({ ownerId: "owner-a", deliveryKey: "a-2", size: 5 })).rejects.toBeInstanceOf(ArtifactOwnerQuotaExceededError);
    await expect(store.checkCapacity({ ownerId: "owner-b", deliveryKey: "b-1", size: 10 })).resolves.toMatchObject({ ownerUsageBytes: 0, prospectiveBytes: 10 });
  });

  it("charges unique owner-scoped CAS bytes, warns above soft quota, and keeps boundary values inclusive", async () => {
    const warnings: unknown[] = [];
    const { store } = createStore({ ownerSoftQuotaBytes: 5, ownerHardQuotaBytes: 10, globalHardQuotaBytes: 20, warnings });
    await store.save(saveInput({ artifactId: "a-1", deliveryKey: "a-1", fileName: "a", bytes: "123456" }));
    await store.save(saveInput({ artifactId: "a-2", deliveryKey: "a-2", fileName: "renamed", bytes: "123456" }));
    await store.save(saveInput({ artifactId: "a-3", deliveryKey: "a-3", fileName: "boundary", bytes: "7890" }));
    expect(warnings).toHaveLength(2);
    await expect(store.checkCapacity({ ownerId: "owner-a", deliveryKey: "a-1", size: 100 })).resolves.toMatchObject({ duplicateDelivery: true, prospectiveBytes: 0 });
    await expect(store.checkCapacity({ ownerId: "owner-a", deliveryKey: "a-4", size: 1 })).rejects.toBeInstanceOf(ArtifactOwnerQuotaExceededError);
  });

  it("blocks the global hard budget without publishing a new reference", async () => {
    const { store } = createStore({ ownerSoftQuotaBytes: 10, ownerHardQuotaBytes: 15, globalHardQuotaBytes: 12 });
    await store.save(saveInput({ ownerId: "owner-a", artifactId: "a-1", deliveryKey: "a-1", fileName: "a", bytes: "12345678" }));
    await store.save(saveInput({ ownerId: "owner-b", artifactId: "b-1", deliveryKey: "b-1", fileName: "b", bytes: "1234" }));
    await expect(store.save(saveInput({ ownerId: "owner-b", artifactId: "b-2", deliveryKey: "b-2", fileName: "blocked", bytes: "x" }))).rejects.toBeInstanceOf(ArtifactGlobalCapacityExceededError);
    await expect(store.list("owner-b")).resolves.toMatchObject([{ artifactId: "b-1" }]);
    await expect(store.get("owner-a", "a-1")).resolves.toMatchObject({ size: 8 });
  });

  it("cleans up after timeout and stream failure so a retry can succeed", async () => {
    const { store } = createStore({ timeoutMs: 5 });
    const stalled = new Readable({ read() {} });
    await expect(store.save(saveInput({ artifactId: "timeout", deliveryKey: "timeout-1", fileName: "x", size: 1, stream: () => stalled }))).rejects.toBeInstanceOf(ArtifactSaveTimeoutError);
    await expect(store.save(saveInput({ artifactId: "failed", deliveryKey: "failure-1", fileName: "x", size: 2, stream: () => Readable.from((async function* () { throw new Error("stream failed"); })()) }))).rejects.toBeInstanceOf(Error);
    await expect(store.save(saveInput({ artifactId: "retry", deliveryKey: "failure-1", fileName: "x", bytes: "ok" }))).resolves.toMatchObject({ deliveryDisposition: "created" });
  });
});
