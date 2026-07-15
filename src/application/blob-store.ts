import { assertSafeVaultPath, assertUserId } from "./document-store.js";

export type StoredBlob = {
  userId: string;
  /** Logical vault path, for example `inbox/2026-07-15/receipt.jpg`. */
  key: string;
  contentType: string;
  size: number;
  createdAt: string;
};

/** Owner-scoped binary objects and generated artifacts. */
export type BlobStore = {
  put(userId: string, key: string, body: Buffer, contentType: string): Promise<StoredBlob>;
  get(userId: string, key: string): Promise<{ blob: StoredBlob; body: Buffer } | null>;
  presignGet(userId: string, key: string, ttlSeconds: number): Promise<string>;
  list(userId: string, prefix?: string): Promise<StoredBlob[]>;
};

export function assertSafeBlobKey(key: string): string {
  return assertSafeVaultPath(key);
}

export function assertPresignTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 60 * 60) throw new Error("ttlSeconds must be an integer between 1 and 3600");
  return ttlSeconds;
}

export function ownerScopedBlobKey(userId: string, key: string): string {
  return `${assertUserId(userId)}/${assertSafeBlobKey(key)}`;
}
