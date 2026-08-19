import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import {
  EngagementReminderSweep,
  engagementReminderDecision,
  engagementReminderLocalWindow,
  maximumAutomaticEngagementReminders,
  type EngagementReminderCandidate,
} from "../../../src/application/engagement-reminder-sweep.js";
import { readEngagementReminderText } from "../../../src/application/engagement-reminder-text.js";
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
  id: "SPEC-MINUTKA-ENGAGEMENT-REMINDERS-001",
  userStory: "US-MINUTKA-ENGAGEMENT-REMINDERS-001",
  requirements: ["FR-MINUTKA-ENGAGEMENT-REMINDERS-001"],
  productParts: ["data-storage-and-privacy-layer", "telegram-shell"],
  contracts: ["engagementReminderRunbook", "privacyBoundary"],
  events: [],
  mastra: [],
  cli: [],
});

const tenant = { companyId: "default_company", groupId: "default_group" };
const timezone = "Europe/Moscow";
/** Moscow is UTC+3, so 10:30Z is 13:30 local: the first hour of the reminder window. */
const insideWindow = (day: string) => `2026-08-${day}T10:30:00.000Z`;
const beforeWindow = (day: string) => `2026-08-${day}T06:00:00.000Z`;
const eveningTouch = (day: string) => `2026-08-${day}T15:00:00.000Z`;

const runbook = readFileSync("docs/runbooks/participant-engagement-reminders.md", "utf8");
const reminderText = readFileSync("vault/assistant/texts/engagement_reminder.md", "utf8");
const skillsMap = readFileSync("docs/product/skills-map.md", "utf8");
const privacy = readFileSync("vault/assistant/docs/privacy-boundary.md", "utf8");
const consent = readFileSync("vault/assistant/processes/consent_and_privacy.md", "utf8");

function expectThreeTiers(text: string): void {
  expect(text).toMatch(/бот|bot|reminder/iu);
  expect(text).toMatch(/методолог|methodologist/iu);
  expect(text).toMatch(/руководител|company lead/iu);
  expect(text).toMatch(/только факт(?:а)? участия|only the participation(?:\/non-participation)? fact/iu);
}

/**
 * One world drives the employee runtime, the operator participation view and the
 * automatic sweep, so a reminder is asserted against the same participant rows
 * the label is read from.
 */
async function participationHarness(input: { completedAt: string; employeeIds: string[] }) {
  let now = input.completedAt;
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });
  for (const employeeId of input.employeeIds) {
    await runtime.service.issueInvite({ employeeId, inviteCode: `invite_${employeeId}`, ...tenant });
    await runtime.service.openInvite({ inviteCode: `invite_${employeeId}` });
    await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
    await runtime.service.completeOnboarding({
      employeeId, roleId: "default_role", preferredName: "Сотрудник",
      assistantName: "Минутка", addressForm: "informal", timezone, persona: "support",
    });
  }

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

  const delivered: { employeeId: string; text: string }[] = [];
  const unreachable = new Set<string>();
  const sweep = new EngagementReminderSweep(
    profiles,
    async ({ employeeId, text }) => {
      if (unreachable.has(employeeId)) return "delivery_session_missing";
      delivered.push({ employeeId, text });
      return "delivered";
    },
    () => readEngagementReminderText(),
    clock,
  );

  return {
    delivered,
    unreachable,
    sweepAt: async (instant: string) => { now = instant; return sweep.run(); },
    employeeWrites: async (instant: string, employeeId: string) => {
      now = instant;
      await assistant.chat({ userId: employeeId, threadId: "daily", text: "Сегодня свёл отчёт." });
    },
    engagement: async (employeeId: string) =>
      (await runtime.service.listParticipants(tenant)).participants.find((candidate) => candidate.employeeId === employeeId),
    turns: () => world.messages.length,
  };
}

describe("SPEC-MINUTKA-ENGAGEMENT-REMINDERS-001: automatic soft reminder for lagging participants", () => {
  it("reminds a lagging participant without an operator and leaves an active one alone", async () => {
    const harness = await participationHarness({ completedAt: "2026-08-17T09:00:00.000Z", employeeIds: ["employee_silent", "employee_active"] });
    await harness.employeeWrites(eveningTouch("18"), "employee_active");

    expect(await harness.sweepAt(insideWindow("19"))).toMatchObject({ considered: 2, sent: 1, failed: 0 });
    expect(harness.delivered).toEqual([{ employeeId: "employee_silent", text: readEngagementReminderText() }]);
    expect(await harness.engagement("employee_silent")).toMatchObject({ engagement: "lagging" });
    expect(await harness.engagement("employee_active")).toMatchObject({ engagement: "active" });
  });

  it("never sends twice within a day and stops after the bounded number of reminders", async () => {
    const harness = await participationHarness({ completedAt: "2026-08-17T09:00:00.000Z", employeeIds: ["employee_silent"] });

    // Two missed days, but still local morning: the reminder waits for the window.
    await harness.sweepAt(beforeWindow("19"));
    expect(harness.delivered).toHaveLength(0);

    await harness.sweepAt(insideWindow("19"));
    await harness.sweepAt(`2026-08-19T17:00:00.000Z`);
    expect(harness.delivered).toHaveLength(1);

    // Each further reminder needs a new lagging streak; the total stays bounded.
    for (const day of ["19", "21", "23", "25"]) {
      await harness.employeeWrites(eveningTouch(day), "employee_silent");
      await harness.sweepAt(insideWindow(String(Number(day) + 2)));
    }
    expect(harness.delivered).toHaveLength(maximumAutomaticEngagementReminders);
  });

  it("keeps silent for a dropped_off participant, whose tier is the methodologist", async () => {
    const harness = await participationHarness({ completedAt: "2026-08-17T09:00:00.000Z", employeeIds: ["employee_silent"] });

    expect(await harness.sweepAt(insideWindow("20"))).toMatchObject({ sent: 0 });
    expect(harness.delivered).toHaveLength(0);
    expect(await harness.engagement("employee_silent")).toMatchObject({ engagement: "dropped_off" });
  });

  it("records no touch, no label change and no conversation turn", async () => {
    const harness = await participationHarness({ completedAt: "2026-08-17T09:00:00.000Z", employeeIds: ["employee_silent"] });
    const turnsBefore = harness.turns();

    await harness.sweepAt(insideWindow("19"));

    expect(harness.delivered).toHaveLength(1);
    expect(harness.turns()).toBe(turnsBefore);
    expect(await harness.engagement("employee_silent")).toMatchObject({ lastTouchOn: "2026-08-17", engagement: "lagging" });
  });

  it("spends no reminder on a participant without a delivery session", async () => {
    const harness = await participationHarness({ completedAt: "2026-08-17T09:00:00.000Z", employeeIds: ["employee_silent"] });
    harness.unreachable.add("employee_silent");

    expect(await harness.sweepAt(insideWindow("19"))).toMatchObject({ sent: 0, failed: 0 });
    harness.unreachable.delete("employee_silent");
    await harness.sweepAt(`2026-08-19T17:00:00.000Z`);
    expect(harness.delivered).toHaveLength(1);
  });

  it("decides from the participation label and the reminder counters only", () => {
    const candidate: EngagementReminderCandidate = {
      employeeId: "employee_silent", timezone, lastTouchOn: "2026-08-17", engagementRemindersSent: 0,
    };

    expect(engagementReminderDecision(candidate, insideWindow("19"))).toBe("send");
    expect(engagementReminderDecision(candidate, insideWindow("18"))).toBe("not_lagging");
    expect(engagementReminderDecision(candidate, insideWindow("20"))).toBe("not_lagging");
    expect(engagementReminderDecision(candidate, beforeWindow("19"))).toBe("outside_local_window");
    expect(engagementReminderDecision({ ...candidate, lastEngagementReminderAt: "2026-08-19T09:00:00.000Z" }, insideWindow("19")))
      .toBe("reminded_recently");
    expect(engagementReminderDecision({ ...candidate, engagementRemindersSent: maximumAutomaticEngagementReminders }, insideWindow("19")))
      .toBe("reminder_limit_reached");
    expect(engagementReminderLocalWindow.fromHour).toBeGreaterThanOrEqual(9);
    expect(engagementReminderLocalWindow.toHour).toBeLessThanOrEqual(22);
  });

  it("delivers one fixed text that discloses later escalation without pressure", () => {
    expect(readEngagementReminderText()).toContain("без оценки и обязательной формы");
    expect(readEngagementReminderText()).toContain("с вами может связаться методолог программы");
    expect(readEngagementReminderText()).toContain("только факт участия или отсутствия участия, без содержания переписки");
    expect(reminderText).toContain("отправляет его дословно, без подстановок и без участия LLM");
    expect(reminderText).toContain("не должен содержать давление, стыд, сравнение с другими участниками, оценку продуктивности");
    expect(runbook).toContain("vault/assistant/texts/engagement_reminder.md");
  });

  it("documents the automatic contour and marks the operator broadcast contract superseded", () => {
    expect(runbook).toContain("Первый ярус сопровождения участия — автоматический");
    expect(runbook).toContain("напоминание отправляется только при метке `lagging`");
    expect(runbook).toContain("не более одного напоминания за скользящие 24 часа");
    expect(runbook).toContain("maximumAutomaticEngagementReminders");
    expect(runbook).toContain("не открывает turn в текущем диалоге, не записывает касание");
    expect(runbook).toContain("**superseded**");
    expect(runbook).toContain("Отдельной групповой команды рассылки в runtime нет");
    expect(runbook).toContain("запрещено");
    expect(skillsMap).toContain("Первый ярус автоматический");
    expect(skillsMap).toContain("прежний контракт с preview и level-2 подтверждением superseded");
  });

  it("runs the sweep from the live runtime over the proactive Telegram delivery path", () => {
    const runtime = readFileSync("src/runtime/create-postgres-runtime.ts", "utf8");
    const delivery = readFileSync("src/runtime/scheduled-action-delivery.ts", "utf8");

    expect(runtime).toMatch(/new EngagementReminderSweep\([\s\S]*createTelegramEngagementReminderDelivery/u);
    expect(runtime).toMatch(/reminderSweep = setInterval\(\(\) => \{ void sweepEngagementReminders\(\); \}/u);
    expect(delivery).toMatch(/createTelegramEngagementReminderDelivery[\s\S]*telegramShell\.deliverReminder/u);
    // A missing delivery session is a skip, not a spent reminder attempt.
    expect(delivery).toMatch(/if \(!delivery\) return "delivery_session_missing";/u);
  });

  it("keeps recipient selection and escalation independent of employee conversations", () => {
    expect(runbook).toContain("Содержание разговоров, activities, traces, insights и персональные выводы для отбора не читаются");
    expect(privacy).toContain("conversation content, activities, traces, insights, inferred reasons, and judgements are not inputs");
    expect(consent).toContain("Conversation content is not used");
  });

  it("states the three escalation tiers and that only the first one is automatic", () => {
    for (const text of [runbook, skillsMap, privacy, consent]) expectThreeTiers(text);
    expect(runbook).toContain("Автоматичен только первый ярус");
    expect(privacy).toContain("Only the first tier is automatic; there is no operator broadcast command");
    expect(consent).toContain("only this first tier is automatic");
  });
});
