import { createPostgresWorkRetrospectivePolicyStore } from "./postgres-work-retrospective-policy-store.js";
import type { Pool } from "pg";
import type { Client } from "minio";
import type { RetrospectiveLifecycle } from "../../application/retrospective-lifecycle.js";
import { recommendationDependsOn } from "../../application/retrospective-lifecycle.js";
import { recommendationArtifactOwner, recommendationArtifactSchema, recommendationArtifactSchemaVersion } from "../../application/retrospective-recommendations.js";
import { ownerScopedArtifactContentKey } from "../../application/artifact-content-store.js";

/** Enumerate immutable history, not just active references. Delete bytes before indexes for retry safety. */
export function createPostgresRetrospectiveLifecycle(pool: Pool, client: Client, bucket: string): RetrospectiveLifecycle {
  const enumerate = async (scope: Parameters<RetrospectiveLifecycle["preview"]>[0]) => {
    const groups = scope.groupId ? [scope.groupId] : (await pool.query<{ group_id: string }>("SELECT id AS group_id FROM minutka_reference.training_groups WHERE company_id=$1", [scope.companyId])).rows.map(r => r.group_id);
    const artifacts: Array<{ owner: string; id: string; digest: string }> = [];
    for (const groupId of groups) {
      const owner = recommendationArtifactOwner({ companyId: scope.companyId, groupId });
      const rows = await pool.query<{ artifact_id: string; content_digest: string }>("SELECT artifact_id, content_digest FROM minutka_private.artifacts WHERE user_id=$1 AND source->>'generatorId'=$2", [owner, recommendationArtifactSchemaVersion]);
      for (const row of rows.rows) {
        if (scope.subjectKey) {
          // A previous interrupted purge may have removed bytes but not its index.
          // Such a reference must be removed, not made readable again.
          let stream;
          try { stream = await client.getObject(bucket, ownerScopedArtifactContentKey(owner, row.content_digest)); }
          catch (error) {
            if (typeof error === "object" && error && "code" in error && (error.code === "NoSuchKey" || error.code === "NoSuchObject")) {
              artifacts.push({ owner, id: row.artifact_id, digest: row.content_digest }); continue;
            }
            throw error;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          const artifact = recommendationArtifactSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
          if (!recommendationDependsOn(artifact, scope)) continue;
        }
        artifacts.push({ owner, id: row.artifact_id, digest: row.content_digest });
      }
    }
    return artifacts;
  };
  return {
    async preview(scope) {
      const artifacts = await enumerate(scope);
      const params = [scope.companyId, scope.groupId ?? null, scope.subjectKey ?? null];
      const predicate = "company_id=$1 AND ($2::text IS NULL OR group_id=$2) AND ($3::uuid IS NULL OR subject_key=$3)";
      const episodes = await pool.query<{ count: string }>(`SELECT count(*) FROM minutka_private.retrospective_episodes WHERE ${predicate}`, params);
      const events = await pool.query<{ count: string }>(`SELECT COALESCE(sum(jsonb_array_length(COALESCE(m.metadata->'retrospectiveEvents','[]'::jsonb)) + jsonb_array_length(COALESCE(m.metadata->'deliveryEvents','[]'::jsonb))),0) AS count FROM minutka_private.messages m JOIN minutka_private.participants p USING(employee_id) WHERE p.company_id=$1 AND ($2::text IS NULL OR p.group_id=$2) AND ($3::uuid IS NULL OR p.subject_key=$3)`, params);
      const policies = scope.subjectKey ? undefined : await pool.query<{ count: string }>("SELECT count(*) FROM minutka_private.retrospective_policies WHERE company_id=$1 AND ($2::text IS NULL OR group_id=$2)", [scope.companyId, scope.groupId ?? null]);
      return { recommendationVersions: artifacts.length, retrospectiveEpisodes: Number(episodes.rows[0]!.count), retrospectiveEvents: Number(events.rows[0]!.count), retrospectivePolicies: Number(policies?.rows[0]?.count ?? 0) };
    },
    async purge(scope) {
      const artifacts = await enumerate(scope);
      let deletedObjectVersions = 0;
      for (const artifact of artifacts) {
        const key = ownerScopedArtifactContentKey(artifact.owner, artifact.digest);
        const versions: Array<{ name?: string; versionId?: string }> = [];
        await new Promise<void>((resolve, reject) => {
          const stream = client.listObjects(bucket, key, true, { IncludeVersion: true });
          stream.on("data", item => { if (item.name === key) versions.push(item); });
          stream.once("error", reject); stream.once("end", resolve);
        });
        for (const version of versions) {
          if (!version.versionId) throw new Error("artifact_version_missing");
          await client.removeObject(bucket, key, { versionId: version.versionId, forceDelete: true });
          deletedObjectVersions++;
        }
        // Every reference to these bytes is derived from the same purged input.
        await pool.query("DELETE FROM minutka_private.artifacts WHERE user_id=$1 AND content_digest=$2", [artifact.owner, artifact.digest]);
        await pool.query("DELETE FROM minutka_private.artifact_contents WHERE user_id=$1 AND content_digest=$2", [artifact.owner, artifact.digest]);
      }
      if (!scope.subjectKey) await createPostgresWorkRetrospectivePolicyStore(pool).purge(scope);
      return { deletedObjectVersions };
    },
  };
}
