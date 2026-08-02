import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import {
  evaluateArtifactCapacity,
  validateArtifactCapacityCheckInput,
  validateArtifactCapacityPolicy,
  type ArtifactCapacityPolicy,
  type ArtifactCapacitySnapshot,
  type ArtifactCapacityWarning,
} from "../../application/artifact-capacity.js";
import { createArtifactSaveDeadline, stageArtifactBody, throwArtifactSaveAbortReason, type ArtifactSaveLimits } from "../../application/artifact-body-stager.js";
import type { ArtifactContentStore } from "../../application/artifact-content-store.js";
import {
  assertArtifactId,
  assertArtifactSource,
  validateSaveArtifactInput,
  type ArtifactReference,
  type ArtifactStore,
  type SaveArtifactInput,
  type SaveArtifactResult,
} from "../../application/artifact-store.js";
import { assertUserId } from "../../application/document-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { withTransaction } from "./postgres-pool.js";

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("telegram"), deliveryKey: z.string(), chatId: z.string(), messageId: z.number().int().positive(), payloadKind: z.enum(["document", "photo", "video", "audio", "animation", "sticker", "voice", "video_note"]), forwarded: z.boolean(), fileId: z.string().optional(), fileUniqueId: z.string().optional(), mediaGroupId: z.string().optional() }),
  z.strictObject({ kind: z.literal("http_upload"), deliveryKey: z.string() }),
  z.strictObject({ kind: z.literal("generated"), deliveryKey: z.string(), generatorId: z.string() }),
  z.strictObject({ kind: z.literal("legacy_blob"), deliveryKey: z.string(), blobKey: z.string() }),
]);

type ArtifactRow = {
  artifact_id: string; user_id: string; content_digest: string; original_file_name: string;
  declared_media_type: string | null; detected_media_type: string | null; size_bytes: string | number;
  source: unknown; caption: string | null; status: "active" | "deleted"; created_at: Date; deleted_at: Date | null;
};

export function createPostgresArtifactStore(input: {
  pool: Pool;
  contentStore: ArtifactContentStore;
  limits: ArtifactSaveLimits;
  capacityPolicy: ArtifactCapacityPolicy;
  onCapacityWarning?: (warning: ArtifactCapacityWarning) => void;
}): ArtifactStore {
  const capacityPolicy = validateArtifactCapacityPolicy(input.capacityPolicy);
  let capacityLock = Promise.resolve();
  return {
    async checkCapacity(capacityInput) {
      const safe = validateArtifactCapacityCheckInput(capacityInput);
      return capacitySnapshot(input.pool, capacityPolicy, safe.ownerId, safe.deliveryKey, safe.size);
    },
    async save(saveInput) {
      validateSaveArtifactInput(saveInput);
      const duplicate = await findByDelivery(input.pool, saveInput.ownerId, saveInput.source.deliveryKey);
      if (duplicate) return duplicateDelivery(duplicate);
      if (saveInput.body.size !== undefined) {
        try {
          await capacitySnapshot(input.pool, capacityPolicy, saveInput.ownerId, saveInput.source.deliveryKey, saveInput.body.size);
        } catch (error) {
          // A known-size body can still reuse same-owner CAS bytes. If there is
          // room for at least one new byte, stage/hash before deciding.
          await capacitySnapshot(input.pool, capacityPolicy, saveInput.ownerId, saveInput.source.deliveryKey, 1);
          if (saveInput.body.size === 0) throw error;
        }
      }
      const deadline = createArtifactSaveDeadline(input.limits.timeoutMs, saveInput.signal);
      let staged: Awaited<ReturnType<typeof stageArtifactBody>> | undefined;
      try {
        staged = await stageArtifactBody(saveInput.body, input.limits, deadline.signal);
        return await withCapacityLock(async () => {
          const existingContent = await input.contentStore.stat(saveInput.ownerId, staged!.contentDigest);
          if (existingContent && existingContent.size !== staged!.size) throw new Error("artifact_content_collision");
          await capacitySnapshot(input.pool, capacityPolicy, saveInput.ownerId, saveInput.source.deliveryKey, existingContent ? 0 : staged!.size);
          if (!existingContent) {
            try {
              await input.contentStore.put({ ownerId: saveInput.ownerId, contentDigest: staged!.contentDigest, size: staged!.size, openStream: staged!.openStream, signal: deadline.signal });
            } catch (error) {
              throwArtifactSaveAbortReason(deadline.signal);
              throw error;
            }
          }
          return persistReference(input.pool, saveInput, staged!.contentDigest, staged!.size, existingContent !== null, capacityPolicy, input.onCapacityWarning);
        });
      } finally {
        deadline.cleanup();
        await staged?.cleanup();
      }
    },
    async get(ownerId, artifactId) {
      const result = await input.pool.query<ArtifactRow>(
        `${SELECT_ARTIFACT} WHERE a.user_id=$1 AND a.artifact_id=$2`,
        [assertUserId(ownerId), assertArtifactId(artifactId)],
      );
      return result.rows[0] ? restore(result.rows[0]) : null;
    },
    async list(ownerId, options) {
      const params: unknown[] = [assertUserId(ownerId), options?.status ?? "active"];
      let limit = "";
      if (options?.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new Error("limit must be a positive safe integer");
        params.push(options.limit); limit = ` LIMIT $${params.length}`;
      }
      const result = await input.pool.query<ArtifactRow>(
        `${SELECT_ARTIFACT} WHERE a.user_id=$1 AND a.status=$2 ORDER BY a.created_at ASC, a.artifact_id ASC${limit}`,
        params,
      );
      return result.rows.map(restore);
    },
    async delete(ownerId, artifactId) {
      const safeOwner = assertUserId(ownerId);
      const safeArtifactId = assertArtifactId(artifactId);
      const current = await input.pool.query<ArtifactRow>(`${SELECT_ARTIFACT} WHERE a.user_id=$1 AND a.artifact_id=$2`, [safeOwner, safeArtifactId]);
      const existing = current.rows[0] ? restore(current.rows[0]) : null;
      if (!existing || existing.status === "deleted") return existing;
      const result = await input.pool.query<ArtifactRow>(
        `WITH updated AS (
           UPDATE minutka_private.artifacts SET status='deleted', deleted_at=COALESCE(deleted_at, now())
           WHERE user_id=$1 AND artifact_id=$2 RETURNING *
         )
         SELECT u.*, c.size_bytes FROM updated u
         JOIN minutka_private.artifact_contents c USING (user_id, content_digest)`,
        [safeOwner, safeArtifactId],
      );
      return result.rows[0] ? restore(result.rows[0]) : null;
    },
  };

  async function withCapacityLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = capacityLock;
    let release!: () => void;
    capacityLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); }
    finally { release(); }
  }
}

async function persistReference(
  pool: Pool,
  input: SaveArtifactInput,
  digest: string,
  size: number,
  contentExisted: boolean,
  capacityPolicy: ArtifactCapacityPolicy,
  onCapacityWarning?: (warning: ArtifactCapacityWarning) => void,
): Promise<SaveArtifactResult> {
  try {
    const result = await withTransaction(pool, async (client) => {
      const existingDelivery = await findByDelivery(client, input.ownerId, input.source.deliveryKey, true);
      if (existingDelivery) return { result: duplicateDelivery(existingDelivery) };
      const indexedContent = await client.query<{ size_bytes: string | number }>(
        "SELECT size_bytes FROM minutka_private.artifact_contents WHERE user_id=$1 AND content_digest=$2 FOR UPDATE",
        [input.ownerId, digest],
      );
      if (indexedContent.rows[0] && Number(indexedContent.rows[0].size_bytes) !== size) throw new Error("artifact_content_collision");
      const capacity = await capacitySnapshot(client, capacityPolicy, input.ownerId, input.source.deliveryKey, indexedContent.rows[0] ? 0 : size);
      const contentInsert = await client.query(
        `INSERT INTO minutka_private.artifact_contents(user_id, content_digest, size_bytes)
         VALUES ($1,$2,$3) ON CONFLICT (user_id, content_digest) DO NOTHING`,
        [input.ownerId, digest, size],
      );
      const stored = await client.query<{ size_bytes: string | number }>(
        "SELECT size_bytes FROM minutka_private.artifact_contents WHERE user_id=$1 AND content_digest=$2 FOR UPDATE",
        [input.ownerId, digest],
      );
      if (Number(stored.rows[0]?.size_bytes) !== size) throw new Error("artifact_content_collision");
      const inserted = await client.query<ArtifactRow>(
        `INSERT INTO minutka_private.artifacts
          (artifact_id,user_id,delivery_key,content_digest,original_file_name,declared_media_type,detected_media_type,source,caption,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'active')
         ON CONFLICT (user_id, delivery_key) DO NOTHING
         RETURNING *, $10::bigint AS size_bytes`,
        [input.artifactId, input.ownerId, input.source.deliveryKey, digest, input.originalFileName, input.declaredMediaType ?? null, input.detectedMediaType ?? null, JSON.stringify(input.source), input.caption ?? null, size],
      );
      if (inserted.rows[0]) {
        return {
          result: { artifact: restore(inserted.rows[0]), deliveryDisposition: "created", contentDisposition: contentExisted || contentInsert.rowCount === 0 ? "reused" : "stored" } as SaveArtifactResult,
          capacity,
        };
      }
      const duplicate = await client.query<ArtifactRow>(`${SELECT_ARTIFACT} WHERE a.user_id=$1 AND a.delivery_key=$2`, [input.ownerId, input.source.deliveryKey]);
      return { result: duplicateDelivery(restore(duplicate.rows[0]!)) };
    });
    if (result.capacity?.ownerSoftLimitExceeded) {
      try {
        onCapacityWarning?.({
          reason: "owner_soft_quota",
          ownerUsageBytes: result.capacity.ownerUsageBytes,
          globalUsageBytes: result.capacity.globalUsageBytes,
          prospectiveBytes: result.capacity.prospectiveBytes,
        });
      } catch { /* metadata-only observability must not fail a durable save */ }
    }
    return result.result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("artifact_")) throw error;
    throw mapPostgresError(error);
  }
}

async function findByDelivery(pool: Pool | PoolClient, ownerId: string, deliveryKey: string, lock = false): Promise<ArtifactReference | null> {
  const result = await pool.query<ArtifactRow>(`${SELECT_ARTIFACT} WHERE a.user_id=$1 AND a.delivery_key=$2${lock ? " FOR UPDATE OF a" : ""}`, [assertUserId(ownerId), deliveryKey]);
  return result.rows[0] ? restore(result.rows[0]) : null;
}

async function capacitySnapshot(
  queryable: Pool | PoolClient,
  policy: ArtifactCapacityPolicy,
  ownerId: string,
  deliveryKey: string,
  prospectiveBytes: number,
): Promise<ArtifactCapacitySnapshot> {
  const usage = await queryable.query<{ owner_usage_bytes: string | number; global_usage_bytes: string | number; duplicate_delivery: boolean }>(
    `SELECT
       COALESCE(SUM(size_bytes) FILTER (WHERE user_id=$1), 0) AS owner_usage_bytes,
       COALESCE(SUM(size_bytes), 0) AS global_usage_bytes,
       EXISTS (SELECT 1 FROM minutka_private.artifacts WHERE user_id=$1 AND delivery_key=$2) AS duplicate_delivery
     FROM minutka_private.artifact_contents`,
    [assertUserId(ownerId), deliveryKey],
  );
  const row = usage.rows[0]!;
  return evaluateArtifactCapacity({
    policy,
    ownerUsageBytes: Number(row.owner_usage_bytes),
    globalUsageBytes: Number(row.global_usage_bytes),
    prospectiveBytes,
    duplicateDelivery: row.duplicate_delivery,
  });
}

function duplicateDelivery(artifact: ArtifactReference): SaveArtifactResult {
  return { artifact, deliveryDisposition: "duplicate_delivery", contentDisposition: "reused" };
}

function restore(row: ArtifactRow): ArtifactReference {
  const source = sourceSchema.parse(row.source);
  assertArtifactSource(source);
  return {
    ownerId: row.user_id,
    artifactId: row.artifact_id,
    contentDigest: row.content_digest,
    originalFileName: row.original_file_name,
    ...(row.declared_media_type === null ? {} : { declaredMediaType: row.declared_media_type }),
    ...(row.detected_media_type === null ? {} : { detectedMediaType: row.detected_media_type }),
    size: Number(row.size_bytes),
    source,
    ...(row.caption === null ? {} : { caption: row.caption }),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at.toISOString() }),
  };
}

const SELECT_ARTIFACT = `SELECT a.*, c.size_bytes FROM minutka_private.artifacts a
JOIN minutka_private.artifact_contents c USING (user_id, content_digest)`;
