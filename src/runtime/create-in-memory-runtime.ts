import { createInMemoryAuditEventStore } from "../application/in-memory-audit-event-store.js";
import { createInMemoryConversationStore } from "../application/in-memory-conversation-store.js";
import { createInMemoryFeedbackStore } from "../application/in-memory-feedback-store.js";
import { createInMemoryInsightStore } from "../application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../application/in-memory-profile-store.js";
import { createInMemoryTelegramInviteRedemptionStore } from "../application/in-memory-telegram-invite-redemption-store.js";
import { createInMemoryTelegramSessionStore } from "../telegram/in-memory-telegram-session-store.js";
import type { TelegramSessionStore } from "../telegram/telegram-session-store.js";
import { createInMemoryWorld, type InMemoryWorld } from "../application/in-memory-world.js";
import { MinutkaService, type AgentRunner, type MinutkaServiceDeps } from "../application/minutka-service.js";
import { createDeterministicIdGenerator } from "../application/runtime-primitives.js";
import type { ConversationDecisionRouter } from "../application/conversation-decision-router.js";
import type { InsightExtractor } from "../application/insight-extractor.js";

export type InMemoryRuntime = {
  service: MinutkaService;
  world: InMemoryWorld;
  telegramSessionStore: TelegramSessionStore;
};

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
  const profileStore = createInMemoryProfileStore(world);
  const auditEventStore = createInMemoryAuditEventStore(world);
  const sessionStore = createInMemoryTelegramSessionStore();
  const service = new MinutkaService(input.agentRunner, {
    profileStore,
    conversationStore: createInMemoryConversationStore(world),
    insightStore: createInMemoryInsightStore(world),
    feedbackStore: createInMemoryFeedbackStore(world),
    auditEventStore,
    telegramInviteRedemptionStore: createInMemoryTelegramInviteRedemptionStore({
      profileStore,
      sessionStore,
      auditEventStore,
    }),
    clock: { now: world.now },
    idGenerator: createDeterministicIdGenerator(),
    ...deps,
  } as MinutkaServiceDeps);
  return { service, world, telegramSessionStore: sessionStore };
}
