import type { Pool } from "pg";
import { RetrospectiveRecommendationService, createRecommendationResearchRead, type RecommendationGenerator } from "../application/retrospective-recommendations.js";
import { createRecommendationParticipants } from "../application/recommendation-participants.js";
import { ResearchEvidenceReadService } from "../application/research-evidence-read.js";
import { createWorkRetrospectiveService } from "../application/work-retrospective-service.js";
import { createPostgresProfileStore } from "../infrastructure/postgres/postgres-profile-store.js";
import { createPostgresConversationStore } from "../infrastructure/postgres/postgres-conversation-store.js";
import { createPostgresWorkRetrospectiveStore } from "../infrastructure/postgres/postgres-work-retrospective-store.js";
import { createPostgresEvaluationCaseStore } from "../infrastructure/postgres/postgres-evaluation-case-store.js";
import { createPostgresResearchTraceStore } from "../infrastructure/postgres/postgres-research-trace-store.js";
import { createPostgresAuditEventStore } from "../infrastructure/postgres/postgres-audit-event-store.js";
import { createPostgresResearchCorpusSource } from "../infrastructure/postgres/postgres-research-corpus-source.js";
import { createPostgresArtifactStore } from "../infrastructure/postgres/postgres-artifact-store.js";
import { createMinioArtifactContentStore } from "../infrastructure/minio/minio-artifact-content-store.js";
import { createMinioClient, minioConfigFromEnv } from "../infrastructure/minio/minio-config.js";
import { artifactRuntimeConfigFromEnv } from "../config/artifacts.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";

/** Read composition is model-free. The drafting agent is constructed only upon generation. */
export function createRetrospectiveReporting(pool: Pool, env: NodeJS.ProcessEnv) {
  const conversations = createPostgresConversationStore(pool);
  const research = createRecommendationResearchRead({
    participants: createRecommendationParticipants(createPostgresProfileStore(pool, postgresConfigFromEnv(env).inviteCodePepper), conversations),
    episodes: createWorkRetrospectiveService(createPostgresWorkRetrospectiveStore(pool), conversations),
    evidence: new ResearchEvidenceReadService(createPostgresEvaluationCaseStore(pool), createPostgresResearchTraceStore(pool), createPostgresAuditEventStore(pool), undefined, undefined, createPostgresResearchCorpusSource(pool)),
  });
  const minio = minioConfigFromEnv(env);
  const contents = createMinioArtifactContentStore({ client: createMinioClient(minio), bucket: minio.bucket });
  const config = artifactRuntimeConfigFromEnv(env);
  const artifacts = createPostgresArtifactStore({ pool, contentStore: contents, limits: config.saveLimits, capacityPolicy: config.capacityPolicy });
  let generator: RecommendationGenerator | undefined;
  const service = new RetrospectiveRecommendationService({ research, artifacts, contents,
    generator: { version: "retrospective-recommendation-generator/v1", async generate(input) {
      if (!generator) {
        const [{ Agent }, { llmAgentConfig }, { createMastraRecommendationGenerator }] = await Promise.all([
          import("@mastra/core/agent"), import("../config/llm.js"), import("../mastra/retrospective-recommendation-generator.js"),
        ]);
        generator = createMastraRecommendationGenerator(new Agent({ id: "minutka-recommendations", name: "Minutka Recommendations", instructions: "Draft evidence-backed recommendations. Return structured output only; operator review is mandatory.", tools: {}, editor: false, ...llmAgentConfig }));
      }
      return generator.generate(input);
    } },
    async loadContent(url) { const response = await fetch(url); if (!response.ok) throw new Error("content_read_failed"); return response.text(); },
  });
  return { research, service, readLatest: service.readLatest.bind(service) };
}
