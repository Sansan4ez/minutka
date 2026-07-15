import * as Minio from "minio";
import { assertPresignTtl, assertSafeBlobKey, ownerScopedBlobKey, type BlobStore, type StoredBlob } from "../../application/blob-store.js";
import { assertUserId } from "../../application/document-store.js";

export type MinioBlobStoreOptions = {
  client: Minio.Client;
  bucket: string;
  now?: () => string;
};

/** MinIO adapter. The API never accepts a raw bucket key from an agent. */
export function createMinioBlobStore(options: MinioBlobStoreOptions): BlobStore {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async put(userId, key, body, contentType) {
      const safeUserId = assertUserId(userId);
      const safeKey = assertSafeBlobKey(key);
      if (!contentType.trim()) throw new Error("contentType is required");
      await options.client.putObject(options.bucket, ownerScopedBlobKey(safeUserId, safeKey), body, body.byteLength, { "Content-Type": contentType.trim() });
      return { userId: safeUserId, key: safeKey, contentType: contentType.trim(), size: body.byteLength, createdAt: now() };
    },
    async get(userId, key) {
      const safeUserId = assertUserId(userId);
      const safeKey = assertSafeBlobKey(key);
      try {
        const scopedKey = ownerScopedBlobKey(safeUserId, safeKey);
        const [stat, stream] = await Promise.all([options.client.statObject(options.bucket, scopedKey), options.client.getObject(options.bucket, scopedKey)]);
        return {
          blob: { userId: safeUserId, key: safeKey, contentType: stat.metaData?.["content-type"] ?? "application/octet-stream", size: stat.size, createdAt: stat.lastModified.toISOString() },
          body: await readBuffer(stream),
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async presignGet(userId, key, ttlSeconds) {
      const scopedKey = ownerScopedBlobKey(assertUserId(userId), key);
      try {
        await options.client.statObject(options.bucket, scopedKey);
      } catch (error) {
        if (isNotFound(error)) throw new Error("blob_not_found");
        throw error;
      }
      return options.client.presignedGetObject(options.bucket, scopedKey, assertPresignTtl(ttlSeconds));
    },
    async list(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const safePrefix = prefix === undefined ? "" : `${assertSafeBlobKey(prefix.replace(/\/+$/, ""))}/`;
      const objects = await collectObjects(options.client.listObjectsV2(options.bucket, `${safeUserId}/${safePrefix}`, true));
      const blobs = await Promise.all(objects
        .filter((object) => object.name && !object.name.endsWith("/"))
        .map(async (object) => {
          const key = object.name!.slice(`${safeUserId}/`.length);
          const stat = await options.client.statObject(options.bucket, ownerScopedBlobKey(safeUserId, key));
          return {
            userId: safeUserId,
            key,
            contentType: stat.metaData?.["content-type"] ?? "application/octet-stream",
            size: stat.size,
            createdAt: stat.lastModified.toISOString(),
          };
        }));
      return blobs.sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}

function readBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function collectObjects(stream: NodeJS.ReadableStream): Promise<Minio.BucketItem[]> {
  return new Promise((resolve, reject) => {
    const objects: Minio.BucketItem[] = [];
    stream.on("data", (object: Minio.BucketItem) => objects.push(object));
    stream.once("error", reject);
    stream.once("end", () => resolve(objects));
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "NoSuchKey" || error.code === "NoSuchObject");
}
