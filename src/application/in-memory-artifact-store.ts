import { createArtifactSaveDeadline, stageArtifactBody, type ArtifactSaveLimits } from "./artifact-body-stager.js";
import type { ArtifactContentStore } from "./artifact-content-store.js";
import {
  assertArtifactId,
  validateSaveArtifactInput,
  type ArtifactListOptions,
  type ArtifactReference,
  type ArtifactStore,
  type SaveArtifactInput,
} from "./artifact-store.js";
import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";

export function createInMemoryArtifactStore(deps: { contentStore: ArtifactContentStore; clock: Clock; limits: ArtifactSaveLimits }): ArtifactStore {
  const references = new Map<string, ArtifactReference>();
  const deliveries = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();
  return {
    save(input) {
      validateSaveArtifactInput(input);
      const ownerId = assertUserId(input.ownerId);
      const deliveryKey = `${ownerId}\u0000${input.source.deliveryKey}`;
      return serialise(locks, deliveryKey, async () => {
        const duplicateId = deliveries.get(deliveryKey);
        if (duplicateId) return { artifact: clone(references.get(referenceKey(ownerId, duplicateId))!), deliveryDisposition: "duplicate_delivery", contentDisposition: "reused" };
        if (references.has(referenceKey(ownerId, input.artifactId))) throw new Error("artifact_id_conflict");
        const deadline = createArtifactSaveDeadline(deps.limits.timeoutMs, input.signal);
        let staged: Awaited<ReturnType<typeof stageArtifactBody>> | undefined;
        try {
          staged = await stageArtifactBody(input.body, deps.limits, deadline.signal);
          const existing = await deps.contentStore.stat(ownerId, staged.contentDigest);
          if (existing && existing.size !== staged.size) throw new Error("artifact_content_collision");
          if (!existing) {
            await deps.contentStore.put({
              ownerId,
              contentDigest: staged.contentDigest,
              size: staged.size,
              openStream: staged.openStream,
              signal: deadline.signal,
            });
          }
          const artifact = referenceFromInput(input, staged.contentDigest, staged.size, deps.clock.now());
          references.set(referenceKey(ownerId, artifact.artifactId), artifact);
          deliveries.set(deliveryKey, artifact.artifactId);
          return { artifact: clone(artifact), deliveryDisposition: "created", contentDisposition: existing ? "reused" : "stored" };
        } finally {
          deadline.cleanup();
          await staged?.cleanup();
        }
      });
    },
    async get(ownerId, artifactId) {
      const artifact = references.get(referenceKey(assertUserId(ownerId), assertArtifactId(artifactId)));
      return artifact ? clone(artifact) : null;
    },
    async list(ownerId, options) {
      const safeOwner = assertUserId(ownerId);
      const limit = validateListLimit(options);
      return [...references.values()]
        .filter((artifact) => artifact.ownerId === safeOwner && artifact.status === (options?.status ?? "active"))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.artifactId.localeCompare(right.artifactId))
        .slice(0, limit)
        .map(clone);
    },
    async delete(ownerId, artifactId) {
      const key = referenceKey(assertUserId(ownerId), assertArtifactId(artifactId));
      const artifact = references.get(key);
      if (!artifact) return null;
      if (artifact.status === "active") references.set(key, { ...artifact, status: "deleted", deletedAt: deps.clock.now() });
      return clone(references.get(key)!);
    },
  };
}

function referenceFromInput(input: SaveArtifactInput, contentDigest: string, size: number, createdAt: string): ArtifactReference {
  return {
    ownerId: input.ownerId,
    artifactId: input.artifactId,
    contentDigest,
    originalFileName: input.originalFileName,
    ...(input.declaredMediaType === undefined ? {} : { declaredMediaType: input.declaredMediaType }),
    ...(input.detectedMediaType === undefined ? {} : { detectedMediaType: input.detectedMediaType }),
    size,
    source: structuredClone(input.source),
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    status: "active",
    createdAt,
  };
}

function validateListLimit(options?: ArtifactListOptions): number | undefined {
  if (options?.limit === undefined) return undefined;
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new Error("limit must be a positive safe integer");
  return options.limit;
}

function referenceKey(ownerId: string, artifactId: string): string {
  return `${ownerId}\u0000${artifactId}`;
}

function clone(artifact: ArtifactReference): ArtifactReference {
  return structuredClone(artifact);
}

async function serialise<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.then(() => current);
  locks.set(key, chain);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}
