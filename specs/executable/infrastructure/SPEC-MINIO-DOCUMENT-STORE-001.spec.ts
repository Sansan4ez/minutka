import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Minio from "minio";
import { prepareMinioBucket } from "../../../src/infrastructure/minio/minio-config.js";
import { createMinioDocumentStore } from "../../../src/infrastructure/minio/minio-document-store.js";
import { createContextBudgetConfig } from "../../../src/application/context-budget.js";
import { createOwnerDocumentReader } from "../../../src/application/document-reader.js";

const bucket = "personal-assistant";

describe("SPEC-MINIO-DOCUMENT-STORE-001: atomic context creation and metadata listing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses startup when the object store overwrites If-None-Match creates", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: false });

    await expect(prepareMinioBucket(client, bucket)).rejects.toThrow(
      "MinIO bucket personal-assistant must enforce conditional object creation",
    );
  });

  it("accepts an object store that preserves the first conditional create", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });

    await expect(prepareMinioBucket(client, bucket)).resolves.toBeUndefined();
    expect(client.objectCount()).toBe(0);
    expect(client.lastRemoveOptions()).toEqual({ forceDelete: true, versionId: "version-1" });
  });

  it("warns without exposing the probe key when conditional-create cleanup fails", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true, cleanupFailures: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(prepareMinioBucket(client, bucket)).resolves.toBeUndefined();
    expect(client.removeAttempts()).toBe(2);
    expect(warn).toHaveBeenCalledWith("MinIO conditional-create probe cleanup failed (TypeError).");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(".runtime-probes/");
  });

  it("heads and reads the exact legacy snapshot through its canonical logical path", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket });
    await client.putObject(bucket, "owner/context/imported-knowledge-base/legacy.md", Buffer.from("legacy🙂"));

    const metadata = await documents.head("owner", "context/legacy.md");
    const document = await documents.get("owner", "context/legacy.md", metadata!);

    expect(metadata).toMatchObject({ path: "context/legacy.md", size: Buffer.byteLength("legacy🙂", "utf8") });
    expect(document).toMatchObject({ path: "context/legacy.md", content: "legacy🙂", version: metadata!.version });
    expect(Object.keys(metadata!)).toEqual(["userId", "path", "version", "updatedAt", "size"]);
    expect(JSON.stringify(metadata)).not.toContain("imported-knowledge-base");
    expect(client.getObjectCalls()).toBe(1);
    expect(client.getObjectCallsFor("owner/context/legacy.md")).toBe(0);
    expect(client.getObjectCallsFor("owner/context/imported-knowledge-base/legacy.md")).toBe(1);
    expect(client.getObjectOptionsFor("owner/context/imported-knowledge-base/legacy.md")).toEqual([{ versionId: metadata!.version }]);
    expect(client.statCallsFor("owner/context/legacy.md")).toBe(1);
    expect(client.statCallsFor("owner/context/imported-knowledge-base/legacy.md")).toBe(1);
  });

  it("lists canonical metadata without reading bodies or statting a legacy alias twice", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket });
    await client.putObject(bucket, "owner/context/imported-knowledge-base/legacy.md", Buffer.from("legacy🙂"));
    await client.putObject(bucket, "owner/context/canonical.md", Buffer.from("canonical"));

    const metadata = await documents.listMetadata("owner");

    expect(metadata.map(({ path }) => path)).toEqual(["context/canonical.md", "context/legacy.md"]);
    expect(metadata.find(({ path }) => path === "context/legacy.md")?.size).toBe(Buffer.byteLength("legacy🙂", "utf8"));
    expect(client.getObjectCalls()).toBe(0);
    expect(client.statCallsFor("owner/context/imported-knowledge-base/legacy.md")).toBe(1);
  });

  it("prefers and reads one pinned canonical snapshot when a legacy alias also exists", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket });
    await client.putObject(bucket, "owner/context/imported-knowledge-base/shared.md", Buffer.from("legacy"));
    await client.putObject(bucket, "owner/context/shared.md", Buffer.from("canonical🙂"));

    const metadata = await documents.listMetadata("owner", "context/");
    const document = await documents.get("owner", "context/shared.md", metadata[0]);

    expect(metadata).toMatchObject([{ path: "context/shared.md", size: Buffer.byteLength("canonical🙂", "utf8") }]);
    expect(document).toMatchObject({ path: "context/shared.md", content: "canonical🙂" });
    expect(client.getObjectCalls()).toBe(1);
    expect(client.getObjectCallsFor("owner/context/shared.md")).toBe(1);
    expect(client.getObjectCallsFor("owner/context/imported-knowledge-base/shared.md")).toBe(0);
    expect(client.getObjectOptionsFor("owner/context/shared.md")).toEqual([{ versionId: metadata[0]!.version }]);
    expect(client.statCallsFor("owner/context/shared.md")).toBe(1);
    expect(client.statCallsFor("owner/context/imported-knowledge-base/shared.md")).toBe(0);
  });

  it("never reads an unverified replacement after the metadata gate", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket });
    await client.putObject(bucket, "owner/context/racy.md", Buffer.from("small"));

    const metadata = await documents.head("owner", "context/racy.md");
    await client.putObject(bucket, "owner/context/racy.md", Buffer.from("replacement body is much larger"));
    const document = await documents.get("owner", "context/racy.md", metadata!);

    expect(document).toBeNull();
    expect(client.getObjectCallsFor("owner/context/racy.md")).toBe(1);
    expect(client.getObjectOptionsFor("owner/context/racy.md")).toEqual([{ versionId: metadata!.version }]);
    expect(client.getObjectBytes()).toBe(0);
    expect(client.statCallsFor("owner/context/racy.md")).toBe(1);
  });

  it("iterates canonical bodies lazily without reading a legacy alias twice", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket });
    await client.putObject(bucket, "owner/context/imported-knowledge-base/shared.md", Buffer.from("legacy"));
    await client.putObject(bucket, "owner/context/shared.md", Buffer.from("canonical"));
    await client.putObject(bucket, "owner/context/tail.md", Buffer.from("tail"));

    const iterator = documents.iterate("owner", "context/")[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.value).toMatchObject({ path: "context/shared.md", content: "canonical" });
    expect(client.getObjectCalls()).toBe(1);
    expect(client.getObjectCallsFor("owner/context/shared.md")).toBe(1);
    expect(client.getObjectCallsFor("owner/context/imported-knowledge-base/shared.md")).toBe(0);
    expect(client.getObjectCallsFor("owner/context/tail.md")).toBe(0);
  });

  it("enforces output and physical scan gates before MinIO getObject", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket });
    await client.putObject(bucket, "owner/context/01.md", Buffer.from("12345"));
    await client.putObject(bucket, "owner/context/02.md", Buffer.from("67890"));
    const reader = createOwnerDocumentReader({
      userId: "owner",
      documentStore: documents,
      contextBudget: createContextBudgetConfig({ documentTools: { turnReadCharacters: 3, maximumDocumentBytes: 5, turnScanBytes: 5 } }),
    });

    await reader.readDocument({ path: "/proc/context/01.md", maxCharacters: 3 });
    const outputBlocked = await reader.readDocument({ path: "/proc/context/01.md", offset: 3, maxCharacters: 3 });
    const scanBlocked = await createOwnerDocumentReader({
      userId: "owner",
      documentStore: documents,
      contextBudget: createContextBudgetConfig({ documentTools: { maximumDocumentBytes: 5, turnScanBytes: 5 } }),
    }).searchDocuments({ query: "missing" });

    expect(outputBlocked).toMatchObject({ readBudgetExhausted: true });
    expect(scanBlocked).toMatchObject({ scanBudgetExhausted: true });
    expect(client.getObjectCalls()).toBe(2);
    expect(client.getObjectBytes()).toBe(10);
  });

  it("supports optimistic update, move, delete and selected-version restore", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket, now: () => "2026-01-01T00:00:00.000Z" });
    const first = await documents.put("owner", "context/versioned.md", "first");
    await client.putObject(bucket, "other/context/versioned.md", Buffer.from("other private version"));
    const updated = await documents.putIfVersion("owner", "context/versioned.md", first.version, "second");
    expect(updated).toMatchObject({ outcome: "updated", document: { content: "second" } });
    if (updated.outcome !== "updated") throw new Error("expected update");
    await expect(documents.putIfVersion("owner", "context/versioned.md", first.version, "stale")).resolves.toMatchObject({ outcome: "conflict" });
    await expect(documents.moveIfVersion("owner", "context/versioned.md", "context/moved.md", updated.document.version)).resolves.toMatchObject({ outcome: "moved" });
    await expect(documents.get("owner", "context/versioned.md")).resolves.toBeNull();
    const moved = await documents.get("owner", "context/moved.md");
    expect(moved).toMatchObject({ content: "second" });
    const deleted = await documents.deleteIfVersion("owner", "context/moved.md", moved!.version);
    expect(deleted).toMatchObject({ outcome: "deleted" });
    await expect(documents.restoreVersion("other", "context/versioned.md", first.version)).resolves.toBeNull();
    await expect(documents.get("other", "context/versioned.md")).resolves.toMatchObject({ content: "other private version" });
    await expect(documents.restoreVersion("owner", "context/versioned.md", first.version)).resolves.toMatchObject({ content: "first", path: "context/versioned.md" });
  });

  it("keeps concurrent and repeated putIfAbsent writes on one stored version", async () => {
    const client = createFakeMinioClient({ honorsConditionalCreate: true });
    const documents = createMinioDocumentStore({ client, bucket, now: () => "2026-01-01T00:00:00.000Z" });
    const path = "context/onboarding-once.md";

    const [first, second] = await Promise.all([
      documents.putIfAbsent("owner", path, "first"),
      documents.putIfAbsent("owner", path, "second"),
    ]);
    const repeated = await documents.putIfAbsent("owner", path, "third");
    const stored = await documents.get("owner", path);

    expect(first.version).toBe(second.version);
    expect(repeated.version).toBe(first.version);
    expect(stored?.content).toBe(first.content);
    expect(["first", "second"]).toContain(stored?.content);
  });
});

type StoredObject = {
  body: Buffer;
  etag: string;
  versionId: string;
  lastModified: Date;
};

function createFakeMinioClient(input: { honorsConditionalCreate: boolean; cleanupFailures?: number }) {
  const objects = new Map<string, StoredObject>();
  const histories = new Map<string, Map<string, StoredObject>>();
  let version = 0;
  let cleanupFailures = input.cleanupFailures ?? 0;
  let removeCount = 0;
  let getObjectCount = 0;
  let getObjectByteCount = 0;
  const getObjectCounts = new Map<string, number>();
  const getObjectOptions = new Map<string, Array<{ versionId?: string } | undefined>>();
  const statCounts = new Map<string, number>();
  let removeOptions: Minio.RemoveOptions | undefined;
  const client = {
    async bucketExists(requestedBucket: string) {
      return requestedBucket === bucket;
    },
    async getBucketVersioning() {
      return { Status: "Enabled" as const };
    },
    async putObject(_bucket: string, objectName: string, body: Buffer | string, _size?: number, metadata?: Minio.ItemBucketMetadata) {
      if (input.honorsConditionalCreate && metadata?.["If-None-Match"] === "*" && objects.has(objectName)) {
        throw objectStoreError("PreconditionFailed");
      }
      const storedBody = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body);
      const stored: StoredObject = {
        body: storedBody,
        etag: `etag-${++version}`,
        versionId: `version-${version}`,
        lastModified: new Date("2026-01-01T00:00:00.000Z"),
      };
      objects.set(objectName, stored);
      const history = histories.get(objectName) ?? new Map<string, StoredObject>();
      history.set(stored.versionId, stored);
      histories.set(objectName, history);
      return { etag: stored.etag, versionId: stored.versionId };
    },
    async statObject(_bucket: string, objectName: string) {
      statCounts.set(objectName, (statCounts.get(objectName) ?? 0) + 1);
      const stored = objects.get(objectName);
      if (!stored) throw objectStoreError("NotFound");
      return {
        size: stored.body.byteLength,
        etag: stored.etag,
        lastModified: stored.lastModified,
        metaData: {},
        versionId: stored.versionId,
      };
    },
    async getObject(_bucket: string, objectName: string, options?: { versionId?: string }) {
      getObjectCount += 1;
      getObjectCounts.set(objectName, (getObjectCounts.get(objectName) ?? 0) + 1);
      getObjectOptions.set(objectName, [...(getObjectOptions.get(objectName) ?? []), options]);
      const current = objects.get(objectName);
      const stored = options?.versionId
        ? current && current.versionId !== options.versionId ? undefined : current ?? histories.get(objectName)?.get(options.versionId)
        : current;
      if (!stored) throw objectStoreError(options?.versionId ? "NoSuchVersion" : "NotFound");
      getObjectByteCount += stored.body.byteLength;
      return Readable.from(stored.body);
    },
    listObjectsV2(_bucket: string, prefix: string) {
      return Readable.from([...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })));
    },
    async removeObject(_bucket: string, objectName: string, options?: Minio.RemoveOptions) {
      removeCount += 1;
      removeOptions = options;
      if (cleanupFailures > 0) {
        cleanupFailures -= 1;
        throw new TypeError("sensitive probe key");
      }
      objects.delete(objectName);
    },
    objectCount() {
      return objects.size;
    },
    removeAttempts() {
      return removeCount;
    },
    getObjectCalls() {
      return getObjectCount;
    },
    getObjectBytes() {
      return getObjectByteCount;
    },
    getObjectCallsFor(objectName: string) {
      return getObjectCounts.get(objectName) ?? 0;
    },
    getObjectOptionsFor(objectName: string) {
      return getObjectOptions.get(objectName) ?? [];
    },
    statCallsFor(objectName: string) {
      return statCounts.get(objectName) ?? 0;
    },
    lastRemoveOptions() {
      return removeOptions;
    },
  };
  return client as typeof client & Minio.Client;
}

function objectStoreError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
