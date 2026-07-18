import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Minio from "minio";
import { prepareMinioBucket } from "../../../src/infrastructure/minio/minio-config.js";
import { createMinioDocumentStore } from "../../../src/infrastructure/minio/minio-document-store.js";

const bucket = "personal-assistant";

describe("SPEC-MINIO-DOCUMENT-STORE-001: atomic context creation", () => {
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
  let version = 0;
  let cleanupFailures = input.cleanupFailures ?? 0;
  let removeCount = 0;
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
      return { etag: stored.etag, versionId: stored.versionId };
    },
    async statObject(_bucket: string, objectName: string) {
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
    async getObject(_bucket: string, objectName: string) {
      const stored = objects.get(objectName);
      if (!stored) throw objectStoreError("NotFound");
      return Readable.from(stored.body);
    },
    listObjectsV2() {
      return Readable.from([]);
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
    lastRemoveOptions() {
      return removeOptions;
    },
  };
  return client as typeof client & Minio.Client;
}

function objectStoreError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
