import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  artifactContentKey,
  validateArtifactContentSize,
  validateArtifactPresignInput,
  type ArtifactContentStore,
  type StoredArtifactContent,
} from "./artifact-content-store.js";
import { assertContentDigest } from "./artifact-store.js";
import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";

type MemoryContent = { content: StoredArtifactContent; body: Buffer };

export function createInMemoryArtifactContentStore(clock: Clock): ArtifactContentStore {
  const objects = new Map<string, MemoryContent>();
  const scopedKey = (ownerId: string, digest: string) => `${assertUserId(ownerId)}\u0000${artifactContentKey(digest)}`;
  return {
    async stat(ownerId, contentDigest) {
      const stored = objects.get(scopedKey(ownerId, contentDigest));
      return stored ? { ...stored.content } : null;
    },
    async put(input) {
      const ownerId = assertUserId(input.ownerId);
      const contentDigest = assertContentDigest(input.contentDigest);
      const size = validateArtifactContentSize(input.size);
      const key = scopedKey(ownerId, contentDigest);
      const existing = objects.get(key);
      if (existing) {
        assertMatchingContent(existing.content, size);
        return { ...existing.content };
      }
      const body = await readBounded(input.openStream(), size, input.signal);
      const actualDigest = createHash("sha256").update(body).digest("hex");
      if (actualDigest !== contentDigest) throw new Error("artifact_content_digest_mismatch");
      const content: StoredArtifactContent = { ownerId, contentDigest, size, createdAt: clock.now() };
      objects.set(key, { content, body });
      return { ...content };
    },
    async presignGet(ownerId, contentDigest, ttlSeconds) {
      validateArtifactPresignInput(ownerId, contentDigest, ttlSeconds);
      if (!objects.has(scopedKey(ownerId, contentDigest))) throw new Error("artifact_content_not_found");
      return `memory://artifact/${encodeURIComponent(ownerId)}/${artifactContentKey(contentDigest)}?ttl=${ttlSeconds}`;
    },
  };
}

function assertMatchingContent(content: StoredArtifactContent, size: number): void {
  if (content.size !== size) throw new Error("artifact_content_collision");
}

async function readBounded(stream: Readable, expectedSize: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw abortError();
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > expectedSize) throw new Error("artifact_content_size_mismatch");
      chunks.push(bytes);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (size !== expectedSize) throw new Error("artifact_content_size_mismatch");
  return Buffer.concat(chunks, size);
}

function abortError(): Error {
  const error = new Error("artifact_save_aborted");
  error.name = "AbortError";
  return error;
}
