import {
  evaluateArtifactCapacity,
  unboundedArtifactCapacityPolicy,
  validateArtifactCapacityCheckInput,
  validateArtifactCapacityPolicy,
  type ArtifactCapacityPolicy,
  type ArtifactCapacityWarning,
} from "./artifact-capacity.js";
import { createArtifactSaveDeadline, stageArtifactBody, throwArtifactSaveAbortReason, type ArtifactSaveLimits } from "./artifact-body-stager.js";
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

export function createInMemoryArtifactStore(deps: {
  contentStore: ArtifactContentStore;
  clock: Clock;
  limits: ArtifactSaveLimits;
  capacityPolicy?: ArtifactCapacityPolicy;
  onCapacityWarning?: (warning: ArtifactCapacityWarning) => void;
}): ArtifactStore {
  const references = new Map<string, ArtifactReference>();
  const deliveries = new Map<string, string>();
  const contents = new Map<string, number>();
  const locks = new Map<string, Promise<void>>();
  const capacityPolicy = validateArtifactCapacityPolicy(deps.capacityPolicy ?? unboundedArtifactCapacityPolicy);
  return {
    async checkCapacity(capacityInput) {
      const safe = validateArtifactCapacityCheckInput(capacityInput);
      const duplicateDelivery = deliveries.has(`${safe.ownerId}\u0000${safe.deliveryKey}`);
      return evaluateArtifactCapacity({
        policy: capacityPolicy,
        ownerUsageBytes: ownerUsage(contents, safe.ownerId),
        globalUsageBytes: totalUsage(contents),
        prospectiveBytes: safe.size,
        duplicateDelivery,
      });
    },
    save(input) {
      validateSaveArtifactInput(input);
      const ownerId = assertUserId(input.ownerId);
      const deliveryKey = `${ownerId}\u0000${input.source.deliveryKey}`;
      return serialise(locks, deliveryKey, async () => {
        const duplicateId = deliveries.get(deliveryKey);
        if (duplicateId) return { artifact: clone(references.get(referenceKey(ownerId, duplicateId))!), deliveryDisposition: "duplicate_delivery", contentDisposition: "reused" };
        if (references.has(referenceKey(ownerId, input.artifactId))) throw new Error("artifact_id_conflict");
        if (input.body.size !== undefined) {
          const preflightOwnerUsage = ownerUsage(contents, ownerId);
          const preflightGlobalUsage = totalUsage(contents);
          try {
            evaluateArtifactCapacity({
              policy: capacityPolicy,
              ownerUsageBytes: preflightOwnerUsage,
              globalUsageBytes: preflightGlobalUsage,
              prospectiveBytes: input.body.size,
            });
          } catch (error) {
            // A known-size body can still be a same-owner CAS reuse. Only reject
            // before opening when the owner/global budget has no room at all.
            evaluateArtifactCapacity({
              policy: capacityPolicy,
              ownerUsageBytes: preflightOwnerUsage,
              globalUsageBytes: preflightGlobalUsage,
              prospectiveBytes: 1,
            });
            if (input.body.size === 0) throw error;
          }
        }
        const deadline = createArtifactSaveDeadline(deps.limits.timeoutMs, input.signal);
        let staged: Awaited<ReturnType<typeof stageArtifactBody>> | undefined;
        try {
          staged = await stageArtifactBody(input.body, deps.limits, deadline.signal);
          const existing = await deps.contentStore.stat(ownerId, staged.contentDigest);
          if (existing && existing.size !== staged.size) throw new Error("artifact_content_collision");
          const capacity = evaluateArtifactCapacity({
            policy: capacityPolicy,
            ownerUsageBytes: ownerUsage(contents, ownerId),
            globalUsageBytes: totalUsage(contents),
            prospectiveBytes: existing ? 0 : staged.size,
          });
          if (!existing) {
            try {
              await deps.contentStore.put({
                ownerId,
                contentDigest: staged.contentDigest,
                size: staged.size,
                openStream: staged.openStream,
                signal: deadline.signal,
              });
            } catch (error) {
              throwArtifactSaveAbortReason(deadline.signal);
              throw error;
            }
          }
          const artifact = referenceFromInput(input, staged.contentDigest, staged.size, deps.clock.now());
          references.set(referenceKey(ownerId, artifact.artifactId), artifact);
          deliveries.set(deliveryKey, artifact.artifactId);
          if (!existing) contents.set(contentKey(ownerId, staged.contentDigest), staged.size);
          if (capacity.ownerSoftLimitExceeded) {
            try {
              deps.onCapacityWarning?.({
                reason: "owner_soft_quota",
                ownerUsageBytes: capacity.ownerUsageBytes,
                globalUsageBytes: capacity.globalUsageBytes,
                prospectiveBytes: capacity.prospectiveBytes,
              });
            } catch { /* metadata-only observability must not fail a durable save */ }
          }
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

function contentKey(ownerId: string, contentDigest: string): string {
  return `${ownerId}\u0000${contentDigest}`;
}

function ownerUsage(contents: Map<string, number>, ownerId: string): number {
  let usage = 0;
  for (const [key, size] of contents) if (key.startsWith(`${ownerId}\u0000`)) usage += size;
  return usage;
}

function totalUsage(contents: Map<string, number>): number {
  let usage = 0;
  for (const size of contents.values()) usage += size;
  return usage;
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
