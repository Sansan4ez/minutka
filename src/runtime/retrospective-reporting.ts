import type { Pool } from "pg";
import { activeProcessIds } from "../application/assistant-manual-loader.js";
import type { CompanyReportSnapshot } from "../application/company-reporting.js";
import { createPostgresTenantDirectoryStore } from "../infrastructure/postgres/postgres-tenant-directory-store.js";
import { RetrospectiveRecommendationService, createRecommendationResearchRead, type RecommendationGenerator, type RecommendationResearchRead } from "../application/retrospective-recommendations.js";
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
  const directory = createPostgresTenantDirectoryStore(pool);
  const reporting = composeRecommendationReporting({ research, service, directory });
  return { research, service, readLatest: service.readLatest.bind(service), reporting };
}

/** Infrastructure seam shared by both production report entrypoints; generation is never requested. */
export function composeRecommendationReporting(input: {
  research: RecommendationResearchRead;
  service: Pick<RetrospectiveRecommendationService, "readLatest">;
  directory: { getGroupPeriod(scope: { companyId: string; groupId: string }): Promise<{ start: string; end: string } | undefined> };
  processIds?: readonly string[];
}) {
  return {
    research: input.research,
    async eligible(scope: { companyId: string; groupId: string }, reference: CompanyReportSnapshot["reference"]) {
      if (!(input.processIds ?? activeProcessIds).includes("work_retrospective") || !reference) return false;
      const period = await input.directory.getGroupPeriod(scope);
      return !!period && period.start === reference.period.start && period.end === reference.period.end;
    },
    async readLatest(scope: { companyId: string; groupId: string }) {
      const result = await input.service.readLatest(scope);
      if (result.status === "not_found") return undefined;
      if (result.status !== "applied") throw new Error("recommendations_read_blocked");
      return result.value;
    },
  };
}
