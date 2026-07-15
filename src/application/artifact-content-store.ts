import type { Readable } from "node:stream";
import { assertContentDigest } from "./artifact-store.js";
import { assertPresignTtl } from "./blob-store.js";
import { assertUserId } from "./document-store.js";

export type StoredArtifactContent = {
  ownerId: string;
  contentDigest: string;
  size: number;
  createdAt: string;
  versionId?: string;
};

export type ArtifactContentStore = {
  stat(ownerId: string, contentDigest: string): Promise<StoredArtifactContent | null>;
  put(input: {
    ownerId: string;
    contentDigest: string;
    size: number;
    openStream(): Readable;
    signal?: AbortSignal;
  }): Promise<StoredArtifactContent>;
  presignGet(ownerId: string, contentDigest: string, ttlSeconds: number): Promise<string>;
};

export function artifactContentKey(contentDigest: string): string {
  const digest = assertContentDigest(contentDigest);
  return `cas/sha256/${digest.slice(0, 2)}/${digest}`;
}

export function ownerScopedArtifactContentKey(ownerId: string, contentDigest: string): string {
  return `${assertUserId(ownerId)}/${artifactContentKey(contentDigest)}`;
}

export function validateArtifactContentSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("artifact content size must be a non-negative safe integer");
  return size;
}

export function validateArtifactPresignInput(ownerId: string, contentDigest: string, ttlSeconds: number): void {
  assertUserId(ownerId);
  assertContentDigest(contentDigest);
  assertPresignTtl(ttlSeconds);
}
