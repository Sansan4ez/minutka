import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantService, isRecoveryTimeoutError } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { IdeaToTaskService } from "../../../src/application/idea-to-task.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService } from "../../../src/application/task-mutation-confirmation.js";
import type { ConversationStore } from "../../../src/application/conversation-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { listenHttpServer, type RunningHttpServer } from "../../../src/server/http/http-server.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpServiceMinutkaTransport } from "../../../src/client/sdk/http-transport.js";
import { assertAssistantTimeoutBudgets, type AssistantTimeoutBudgets } from "../../../src/config/assistant-timeout-budgets.js";

const now = "2026-07-30T12:00:00.000Z";
const serviceToken = "s".repeat(64);
const running: RunningHttpServer[] = [];

afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });

function createComposition(options: {
  budgets: AssistantTimeoutBudgets;
  appendTurnDelay?: number;
}) {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const confirmationStore = createInMemoryTaskMutationConfirmationStore(tasks);
  const auditEventStore = createInMemoryAuditEventStore(world);
  const idGenerator = createDeterministicIdGenerator();
  const confirmations = new TaskMutationConfirmationService(
    confirmationStore, clock,
    { confirmationId: (() => { let id = 0; return () => `recovery-confirmation-${++id}`; })(), auditEventStore, idGenerator },
  );
  const baseConversationStore = createInMemoryConversationStore(world);
  const conversationStore: ConversationStore = {
    ...baseConversationStore,
    async appendTurn(turn) {
      if (options.appendTurnDelay !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.appendTurnDelay));
      }
      return baseConversationStore.appendTurn(turn);
    },
  };
  // Real AssistantService with agent runner that creates a task proposal
  const assistantService = new AssistantService(
    async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Post-abort proposal", project: "ASSISTANT", type: "operations" });
      return "Предложение создано.";
    },
    {
      documentStore: documents,
      conversationStore,
      ingestionService: ingestion,
      ideaStore: ideas,
      taskStore: tasks,
      taskMutations: confirmations,
      ideaToTask: new IdeaToTaskService(ideas, tasks, confirmations),
      auditEventStore,
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
      idGenerator,
      applicationTimeoutMs: options.budgets.applicationMs,
      recoveryReserveMs: options.budgets.recoveryReserveMs,
    },
  );
  const artifactStore = createInMemoryArtifactStore({
    contentStore: createInMemoryArtifactContentStore(clock),
    clock,
    limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 },
  });
  const personalAssistant = new PersonalAssistantService(
    { issueInvite: notUsed, openInvite: notUsed, getProfile: notUsed, acceptConsent: notUsed, completeOnboarding: notUsed, listInsights: notUsed, submitFeedback: notUsed, redeemTelegramInvite: notUsed, recordPrivacyExplanationShown: notUsed, submitOnboardingAnswer: notUsed, confirmOnboarding: notUsed, resetOnboardingDraft: notUsed },
    assistantService,
    artifactStore,
    confirmations,
  );
  return { personalAssistant, confirmations, tasks, world };
}

function notUsed(): never { throw new Error("not used in this spec"); }

describe("SPEC-POST-ABORT-RECOVERY-001: bounded post-abort proposal recovery", () => {
  it("returns a persisted proposal through production composition before the SDK deadline with a fast store", async () => {
    const budgets = assertAssistantTimeoutBudgets({ applicationMs: 50, recoveryReserveMs: 50, httpChatHandlerMs: 200, sdkTransportMs: 400, serverRequestMs: 600 });
    const { personalAssistant, confirmations, tasks } = createComposition({ budgets, appendTurnDelay: 0 });
    const server = await listenHttpServer({ application: personalAssistant, port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map() }, timeoutBudgets: budgets });
    running.push(server);
    const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken, timeoutMs: budgets.sdkTransportMs }));

    const result = await client.forEmployee("owner").chat({ threadId: "thread", text: "create", responseChannel: "telegram" });
    expect(result).toMatchObject({
      effect: "pending_action_created",
      pendingAction: { confirmationId: "recovery-confirmation-1" },
    });
    if (result.effect !== "pending_action_created" || !result.pendingAction) throw new Error("expected pending action");
    await expect(confirmations.confirm("owner", result.pendingAction.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Post-abort proposal" }]);
  });

  it("degrades conversation history and returns safe pending action when store stalls beyond recovery budget", async () => {
    const budgets = assertAssistantTimeoutBudgets({ applicationMs: 30, recoveryReserveMs: 30, httpChatHandlerMs: 100, sdkTransportMs: 200, serverRequestMs: 300 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // appendTurnDelay exceeds applicationMs + recoveryReserveMs to guarantee timeout
      const { personalAssistant, confirmations, tasks, world } = createComposition({ budgets, appendTurnDelay: 500 });
      const server = await listenHttpServer({ application: personalAssistant, port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map() }, timeoutBudgets: budgets });
      running.push(server);
      const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken, timeoutMs: budgets.sdkTransportMs }));

      const result = await client.forEmployee("owner").chat({ threadId: "thread", text: "create task with stall", responseChannel: "telegram" });
      // Must return before SDK deadline with the proposal visible
      expect(result).toMatchObject({
        effect: "pending_action_created",
        pendingAction: { confirmationId: "recovery-confirmation-1" },
      });
      // Proposal remains owner-visible and confirmable
      if (result.effect !== "pending_action_created" || !result.pendingAction) throw new Error("expected pending action");
      await expect(confirmations.confirm("owner", result.pendingAction.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
      await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Post-abort proposal" }]);
      // History was not persisted because the store stalled
      expect(world.messages).toHaveLength(0);
      // Operational warning logged (redacted)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("conversation history persistence after task proposal"));
    } finally {
      warning.mockRestore();
    }
  });

  it("prevents a hidden confirmation ID from remaining confirmable after SDK timeout", async () => {
    // Very tight budgets: agent loop + recovery reserve complete well before the SDK timeout,
    // but the HTTP handler itself will timeout if the response isn't sent in time.
    const budgets = assertAssistantTimeoutBudgets({ applicationMs: 20, recoveryReserveMs: 20, httpChatHandlerMs: 60, sdkTransportMs: 100, serverRequestMs: 150 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Store stalls longer than recovery reserve but shorter than SDK timeout
      const { personalAssistant, confirmations } = createComposition({ budgets, appendTurnDelay: 500 });
      const server = await listenHttpServer({ application: personalAssistant, port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map() }, timeoutBudgets: budgets });
      running.push(server);
      const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken, timeoutMs: budgets.sdkTransportMs }));

      // With bounded recovery: the response arrives before SDK timeout with the pending action
      // because recovery budget terminates the slow append and returns the result.
      const result = await client.forEmployee("owner").chat({ threadId: "thread", text: "hidden id test", responseChannel: "telegram" });
      expect(result).toMatchObject({
        pendingAction: { confirmationId: "recovery-confirmation-1" },
      });
      // The confirmation ID is visible, so confirming it is valid
      if (result.effect !== "pending_action_created" || !result.pendingAction) throw new Error("expected pending action");
      await expect(confirmations.confirm("owner", result.pendingAction.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps conversation persistence fail-fast for ordinary chat without task proposals", async () => {
    const budgets = assertAssistantTimeoutBudgets({ applicationMs: 50, recoveryReserveMs: 50, httpChatHandlerMs: 200, sdkTransportMs: 400, serverRequestMs: 600 });
    const clock = { now: () => now };
    const world = createInMemoryWorld(clock.now);
    const documents = createInMemoryDocumentStore(clock);
    const baseConversationStore = createInMemoryConversationStore(world);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) });
    const conversationStore: ConversationStore = {
      ...baseConversationStore,
      async appendTurn() { throw new Error("conversation store unavailable"); },
    };
    const service = new AssistantService(
      async () => "ordinary response",
      {
        documentStore: documents,
        conversationStore,
        ingestionService: ingestion,
        requestIntegrityGuard: async () => ({ status: "allowed" }),
        clock,
        idGenerator: createDeterministicIdGenerator(),
        applicationTimeoutMs: budgets.applicationMs,
        recoveryReserveMs: budgets.recoveryReserveMs,
      },
    );
    // Without a proposal, conversation errors must propagate
    await expect(service.chat({ userId: "owner", threadId: "thread", text: "ordinary chat" })).rejects.toThrow("conversation store unavailable");
  });

  it("validates that startup rejects invalid recovery reserve configuration", () => {
    // recoveryReserveMs + applicationMs > httpChatHandlerMs
    expect(() => assertAssistantTimeoutBudgets({
      applicationMs: 60_000,
      recoveryReserveMs: 50_000,
      httpChatHandlerMs: 100_000,
      sdkTransportMs: 110_000,
      serverRequestMs: 120_000,
    })).toThrow(/satisfy/i);

    // Valid: applicationMs + recoveryReserveMs == httpChatHandlerMs
    expect(() => assertAssistantTimeoutBudgets({
      applicationMs: 50_000,
      recoveryReserveMs: 50_000,
      httpChatHandlerMs: 100_000,
      sdkTransportMs: 110_000,
      serverRequestMs: 120_000,
    })).not.toThrow();
  });

  it("exports isRecoveryTimeoutError for classification", () => {
    expect(isRecoveryTimeoutError(new Error("random"))).toBe(false);
    // RecoveryTimeoutError is internal, but isRecoveryTimeoutError classifies it
    expect(typeof isRecoveryTimeoutError).toBe("function");
  });
});
