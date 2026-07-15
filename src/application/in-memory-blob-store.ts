import { assertPresignTtl, assertSafeBlobKey, type BlobStore, type StoredBlob } from "./blob-store.js";
import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";

type MemoryBlob = { blob: StoredBlob; body: Buffer };

/** Hermetic adapter for executable specs; production composition must use MinIO. */
export function createInMemoryBlobStore(clock: Clock): BlobStore {
  const blobs = new Map<string, MemoryBlob>();
  const scopedKey = (userId: string, key: string) => `${assertUserId(userId)}\u0000${assertSafeBlobKey(key)}`;
  return {
    async put(userId, key, body, contentType) {
      const safeUserId = assertUserId(userId);
      const safeKey = assertSafeBlobKey(key);
      if (!contentType.trim()) throw new Error("contentType is required");
      const blob: StoredBlob = { userId: safeUserId, key: safeKey, contentType: contentType.trim(), size: body.byteLength, createdAt: clock.now() };
      blobs.set(scopedKey(safeUserId, safeKey), { blob, body: Buffer.from(body) });
      return { ...blob };
    },
    async get(userId, key) {
      const stored = blobs.get(scopedKey(userId, key));
      return stored ? { blob: { ...stored.blob }, body: Buffer.from(stored.body) } : null;
    },
    async presignGet(userId, key, ttlSeconds) {
      assertPresignTtl(ttlSeconds);
      const stored = blobs.get(scopedKey(userId, key));
      if (!stored) throw new Error("blob_not_found");
      return `memory://blob/${encodeURIComponent(stored.blob.userId)}/${stored.blob.key.split("/").map(encodeURIComponent).join("/")}?ttl=${ttlSeconds}`;
    },
    async list(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const safePrefix = prefix === undefined ? undefined : `${assertSafeBlobKey(prefix.replace(/\/+$/, ""))}/`;
      return [...blobs.values()]
        .map(({ blob }) => blob)
        .filter((blob) => blob.userId === safeUserId && (!safePrefix || blob.key.startsWith(safePrefix)))
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((blob) => ({ ...blob }));
    },
  };
}
