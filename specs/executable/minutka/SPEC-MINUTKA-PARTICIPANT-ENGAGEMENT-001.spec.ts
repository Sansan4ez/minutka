import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { registerSpecMetadata } from "../support/spec-harness.js";

registerSpecMetadata({
  id: "SPEC-MINUTKA-PARTICIPANT-ENGAGEMENT-001",
  userStory: "US-MINUTKA-ENGAGEMENT-REMINDERS-001",
  requirements: ["FR-MINUTKA-ENGAGEMENT-REMINDERS-001"],
  productParts: ["data-storage-and-privacy-layer"],
  contracts: ["operatorReminderRunbook"],
  events: [],
  mastra: [],
  cli: [],
});

const tenant = { companyId: "default_company", groupId: "default_group" };

/**
 * One world drives both the operator view (MinutkaService.listParticipants) and
 * the live employee runtime (AssistantService.chat), so the participation label
 * is asserted against the same participant row both of them read.
 */
async function onboardedParticipant(instants: { completedAt: string }) {
  let now = instants.completedAt;
  const world = createInMemoryWorld(() => now);
  const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });
  await runtime.service.issueInvite({ employeeId: "employee_a", inviteCode: "invite_employee_a", ...tenant });
  await runtime.service.openInvite({ inviteCode: "invite_employee_a" });
  await runtime.service.acceptConsent({ employeeId: "employee_a", accepted: true, source: "test" });
  await runtime.service.completeOnboarding({
    employeeId: "employee_a", roleId: "default_role", preferredName: "Сотрудник",
    assistantName: "Минутка", addressForm: "informal", timezone: "Europe/Moscow", persona: "support",
  });

  const clock = { now: () => now };
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const conversationStore = createInMemoryConversationStore(world);
  const profiles = createInMemoryProfileStore(world);
  const assistant = new AssistantService(async () => "Понял.", {
    documentStore: documents,
    conversationStore,
    ideaStore: ideas,
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    participantStore: profiles,
    chatProjectionBuilder: createRuntimeProjectionBuilder({
      profileStore: profiles,
      conversationStore,
      insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world),
      auditEventStore: createInMemoryAuditEventStore(world),
      clock,
    }),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });

  return {
    assistant,
    listEngagement: async () => (await runtime.service.listParticipants(tenant)).participants[0],
    participant: () => world.participants.find(({ employeeId }) => employeeId === "employee_a")!,
    travelTo: (instant: string) => { now = instant; },
  };
}

describe("SPEC-MINUTKA-PARTICIPANT-ENGAGEMENT-001: the participation label follows employee touches only", () => {
  it("starts the engagement clock at onboarding completion in the profile timezone", async () => {
    // 00:30 Moscow on 2026-08-18, so a UTC-dated clock would record the day before.
    const { participant, listEngagement } = await onboardedParticipant({ completedAt: "2026-08-17T21:30:00.000Z" });

    expect(participant().lastTouchOn).toBe("2026-08-18");
    expect(await listEngagement()).toMatchObject({ employeeId: "employee_a", status: "profile_completed", engagement: "active" });
  });

  it("degrades a silent participant to lagging and then dropped_off even while scheduled fires keep running", async () => {
    const { assistant, participant, listEngagement, travelTo } = await onboardedParticipant({ completedAt: "2026-08-17T09:00:00.000Z" });
    expect(participant().lastTouchOn).toBe("2026-08-17");

    for (const [instant, processId] of [
      ["2026-08-18T05:30:00.000Z", "morning_planning"],
      ["2026-08-18T16:00:00.000Z", "evening_reflection"],
      ["2026-08-19T05:30:00.000Z", "morning_planning"],
    ] as const) {
      travelTo(instant);
      await assistant.chat({ userId: "employee_a", threadId: "daily", text: "Запланированный запуск", requiredProcessId: processId });
    }

    // Scheduled fires are the service talking to the employee, not the employee
    // answering, so none of them may move the touch date.
    expect(participant().lastTouchOn).toBe("2026-08-17");
    expect(await listEngagement()).toMatchObject({ lastTouchOn: "2026-08-17", engagement: "lagging" });

    travelTo("2026-08-20T05:30:00.000Z");
    await assistant.chat({ userId: "employee_a", threadId: "daily", text: "Запланированный запуск", requiredProcessId: "morning_planning" });
    expect(await listEngagement()).toMatchObject({ lastTouchOn: "2026-08-17", engagement: "dropped_off" });
  });

  it("counts an employee-initiated message as a touch on the employee's local day", async () => {
    const { assistant, participant, listEngagement, travelTo } = await onboardedParticipant({ completedAt: "2026-08-17T09:00:00.000Z" });

    // 00:30 Moscow on 2026-08-21: the local day, not the UTC day, is recorded.
    travelTo("2026-08-20T21:30:00.000Z");
    await assistant.chat({ userId: "employee_a", threadId: "daily", text: "Сегодня свёл отчёт и провёл планёрку." });

    expect(participant().lastTouchOn).toBe("2026-08-21");
    expect(await listEngagement()).toMatchObject({ lastTouchOn: "2026-08-21", engagement: "active" });
  });

  it("routes every scheduled process through the same required-process input the touch write skips", () => {
    const source = readFileSync("src/application/personal-assistant-service.ts", "utf8");
    const write = readFileSync("src/application/assistant-service.ts", "utf8");

    expect(source).toMatch(/runScheduledProcess[\s\S]*requiredProcessId: input\.processId/u);
    expect(write).toMatch(/if \(requiredProcessId === undefined\) await this\.deps\.participantStore\.recordParticipantTouch/u);
  });
});
