import * as Minio from "minio";
import {
  ownerScopedArtifactContentKey,
  validateArtifactContentSize,
  validateArtifactPresignInput,
  type ArtifactContentStore,
  type StoredArtifactContent,
} from "../../application/artifact-content-store.js";
import { assertContentDigest } from "../../application/artifact-store.js";
import { assertPresignTtl } from "../../application/blob-store.js";
import { assertUserId } from "../../application/document-store.js";

export function createMinioArtifactContentStore(options: {
  client: Minio.Client;
  bucket: string;
}): ArtifactContentStore {
  return {
    async stat(ownerId, contentDigest) {
      const safeOwner = assertUserId(ownerId);
      const digest = assertContentDigest(contentDigest);
      try {
        const stat = await options.client.statObject(options.bucket, ownerScopedArtifactContentKey(safeOwner, digest));
        return fromStat(safeOwner, digest, stat);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async put(input) {
      const ownerId = assertUserId(input.ownerId);
      const contentDigest = assertContentDigest(input.contentDigest);
      const size = validateArtifactContentSize(input.size);
      const objectKey = ownerScopedArtifactContentKey(ownerId, contentDigest);
      try {
        const existing = await options.client.statObject(options.bucket, objectKey);
        const content = fromStat(ownerId, contentDigest, existing);
        if (content.size !== size) throw new Error("artifact_content_collision");
        return content;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (input.signal?.aborted) throw abortError(input.signal);
      const stream = input.openStream();
      const abort = () => stream.destroy(abortError(input.signal!));
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        try {
          const uploaded = await options.client.putObject(options.bucket, objectKey, stream, size, {
            "Content-Type": "application/octet-stream",
            "X-Amz-Meta-Sha256": contentDigest,
            "If-None-Match": "*",
          });
          return {
            ownerId,
            contentDigest,
            size,
            createdAt: new Date().toISOString(),
            ...(uploaded.versionId === null ? {} : { versionId: uploaded.versionId }),
          };
        } catch (error) {
          if (!isPreconditionFailed(error)) throw error;
          const existing = fromStat(ownerId, contentDigest, await options.client.statObject(options.bucket, objectKey));
          if (existing.size !== size) throw new Error("artifact_content_collision");
          return existing;
        }
      } finally {
        input.signal?.removeEventListener("abort", abort);
        if (!stream.destroyed) stream.destroy();
      }
    },
    async presignGet(ownerId, contentDigest, ttlSeconds) {
      validateArtifactPresignInput(ownerId, contentDigest, ttlSeconds);
      const key = ownerScopedArtifactContentKey(ownerId, contentDigest);
      try {
        await options.client.statObject(options.bucket, key);
      } catch (error) {
        if (isNotFound(error)) throw new Error("artifact_content_not_found");
        throw error;
      }
      return options.client.presignedGetObject(options.bucket, key, assertPresignTtl(ttlSeconds));
    },
  };
}

function fromStat(ownerId: string, contentDigest: string, stat: Minio.BucketItemStat): StoredArtifactContent {
  return {
    ownerId,
    contentDigest,
    size: stat.size,
    createdAt: stat.lastModified.toISOString(),
    ...(stat.versionId === null || stat.versionId === undefined ? {} : { versionId: stat.versionId }),
  };
}

function isPreconditionFailed(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "PreconditionFailed" || error.code === "ConditionalRequestConflict");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "NotFound" || error.code === "NoSuchKey" || error.code === "NoSuchObject");
}

function abortError(signal: AbortSignal): Error {
  const error = signal.reason instanceof Error ? signal.reason : new Error("artifact_save_aborted");
  if (error.name === "Error") error.name = "AbortError";
  return error;
}
