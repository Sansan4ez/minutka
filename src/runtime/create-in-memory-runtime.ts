import { createInMemoryAuditEventStore } from "../application/in-memory-audit-event-store.js";
import { createInMemoryConversationStore } from "../application/in-memory-conversation-store.js";
import { createInMemoryFeedbackStore } from "../application/in-memory-feedback-store.js";
import { createInMemoryInsightStore } from "../application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../application/in-memory-profile-store.js";
import { createInMemoryWorld, type InMemoryWorld } from "../application/in-memory-world.js";
import { MinutkaService, type AgentRunner, type MinutkaServiceDeps } from "../application/minutka-service.js";
import { createDeterministicIdGenerator } from "../application/runtime-primitives.js";
import type { ConversationDecisionRouter } from "../application/conversation-decision-router.js";
import type { InsightExtractor } from "../application/insight-extractor.js";

export type InMemoryRuntime = { service: MinutkaService; world: InMemoryWorld };

/** Executable-spec composition only. Production must use createPostgresRuntime. */
export function createInMemoryRuntime(input: {
  agentRunner: AgentRunner;
  world?: InMemoryWorld;
  deps?: Pick<MinutkaServiceDeps, "contextBuilder" | "agentManualRouter" | "manual"> & {
    conversationDecisionRouter?: ConversationDecisionRouter;
    insightExtractor?: InsightExtractor;
  };
}): InMemoryRuntime {
  const world = input.world ?? createInMemoryWorld();
  const deps = input.deps ?? {};
  const service = new MinutkaService(input.agentRunner, {
    profileStore: createInMemoryProfileStore(world),
    conversationStore: createInMemoryConversationStore(world),
    insightStore: createInMemoryInsightStore(world),
    feedbackStore: createInMemoryFeedbackStore(world),
    auditEventStore: createInMemoryAuditEventStore(world),
    clock: { now: world.now },
    idGenerator: createDeterministicIdGenerator(),
    ...deps,
  } as MinutkaServiceDeps);
  return { service, world };
}
