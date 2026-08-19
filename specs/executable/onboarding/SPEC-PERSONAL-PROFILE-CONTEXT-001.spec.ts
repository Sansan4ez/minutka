import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { createInMemoryResearchTraceState, createInMemoryResearchTraceStore } from "../../../src/application/in-memory-research-trace-store.js";
import { createInMemoryActivityCollectionState } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { createUpdatePersonalContextTool, personalProfileContextPatchSchema } from "../../../src/mastra/tools/profile-context-tool.js";
import { completeOnboardingRequestSchema, onboardingFieldSchema } from "../../../src/contracts/minutka-api.js";

const now = "2026-08-19T09:00:00.000Z";

async function readyProfile(world: ReturnType<typeof createInMemoryWorld>, employeeId: string, inviteCode: string) {
  const profiles = createInMemoryProfileStore(world);
  await profiles.issueInvite({ employeeId, inviteCode, companyId: "default_company", groupId: "default_group", issuedAt: now });
  await profiles.openInvite({ inviteCode, openedAt: now, explanationShownAt: now });
  await profiles.acceptConsent({ employeeId, privacyVersion: "privacy-v6", acceptedAt: now, explanationShownAt: now, source: "test" });
  await profiles.completeProfile({
    completedAt: now,
    profile: {
      employeeId, companyId: "default_company", groupId: "default_group", roleId: "default_role",
      preferredName: employeeId, assistantName: "Минутка", addressForm: "informal", persona: "support",
      responseLength: "balanced", timezone: "Etc/UTC", createdAt: now, updatedAt: now,
    },
  });
  return profiles;
}

function assistant(input: {
  world: ReturnType<typeof createInMemoryWorld>;
  profiles: ReturnType<typeof createInMemoryProfileStore>;
  traces?: ReturnType<typeof createInMemoryResearchTraceStore>;
  runner: ConstructorParameters<typeof AssistantService>[0];
}) {
  const clock = { now: () => now };
  const documents = createInMemoryDocumentStore(clock);
  const conversations = createInMemoryConversationStore(input.world);
  return new AssistantService(input.runner, {
    documentStore: documents,
    conversationStore: conversations,
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    participantStore: input.profiles,
    chatProjectionBuilder: createRuntimeProjectionBuilder({
      profileStore: input.profiles,
      conversationStore: conversations,
      insightStore: createInMemoryInsightStore(input.world),
      feedbackStore: createInMemoryFeedbackStore(input.world),
      auditEventStore: createInMemoryAuditEventStore(input.world),
      clock,
    }),
    researchTraceStore: input.traces,
    researchTraceVersions: input.traces ? { promptVersion: "prompt/v1", processVersion: "process/v1", taxonomyVersion: "taxonomy/v1", model: "test" } : undefined,
    auditEventStore: createInMemoryAuditEventStore(input.world),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
}

describe("SPEC-PERSONAL-PROFILE-CONTEXT-001: conversational personal context", () => {
  it("keeps onboarding at four form fields and accepts optional direct HTTP/CLI context", () => {
    expect(onboardingFieldSchema.options).toEqual(["roleId", "preferredName", "communicationStyle", "timezone"]);
    expect(completeOnboardingRequestSchema.parse({
      roleId: "default_role", persona: "support",
      typicalTasks: ["Еженедельная отчётность"], aiLevel: "intermediate", programGoal: "Сократить ручную рутину",
    })).toMatchObject({ typicalTasks: ["Еженедельная отчётность"], aiLevel: "intermediate", programGoal: "Сократить ручную рутину" });
    expect(completeOnboardingRequestSchema.parse({ roleId: "default_role", persona: "support" })).toEqual({ roleId: "default_role", persona: "support" });
  });

  it("records stated context from an ordinary turn, exposes it to the owner, and bounds values", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyProfile(world, "employee_a", "invite_a");
    const service = assistant({
      world, profiles,
      runner: async (_input, context) => {
        await context.updatePersonalContext({
          typicalTasks: ["  Еженедельная   отчётность  ", "Координация подрядчиков", "Еженедельная отчётность"],
          aiLevel: "intermediate",
          programGoal: `Освободить время для важных задач ${"x".repeat(700)}`,
        });
        return { text: "Запомнил.", executionTrace: [{ kind: "tool", toolName: "updatePersonalContext" }] };
      },
    });

    await service.chat({ userId: "employee_a", threadId: "thread_a", text: "Обычно делаю отчёты и координирую подрядчиков; с ИИ работал немного. Хочу освободить время." });
    const profile = await profiles.getProfile("employee_a");
    expect(profile).toMatchObject({
      typicalTasks: ["Еженедельная отчётность", "Координация подрядчиков"],
      aiLevel: "intermediate",
    });
    expect(Array.from(profile?.programGoal ?? "")).toHaveLength(500);
    expect(world.auditEvents.find((event) => event.type === "profile_updated")?.metadata).toEqual({ changedFields: ["typicalTasks", "aiLevel", "programGoal"] });

    let nextContext = "";
    const reader = assistant({ world, profiles, runner: async (_input, context) => { nextContext = context.systemContext; return "ok"; } });
    await reader.chat({ userId: "employee_a", threadId: "thread_a", text: "Что ты обо мне помнишь?" });
    expect(nextContext).toContain("Регулярные задачи: Еженедельная отчётность, Координация подрядчиков");
    expect(nextContext).toContain("Уровень знакомства с ИИ: intermediate");
    expect(nextContext).toContain("Личная цель программы:");
  });

  it("keeps missing context optional and isolates owner updates", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyProfile(world, "employee_a", "invite_a");
    await readyProfile(world, "employee_b", "invite_b");
    const before = await profiles.getProfile("employee_a");
    const noWrite = assistant({ world, profiles, runner: async () => "Продолжим с вашим днём." });
    await noWrite.chat({ userId: "employee_a", threadId: "thread_a", text: "Сегодня пока нечего добавить" });
    expect(await profiles.getProfile("employee_a")).toEqual(before);

    const ownerA = assistant({ world, profiles, runner: async (_input, context) => { await context.updatePersonalContext({ aiLevel: "advanced" }); return "ok"; } });
    await ownerA.chat({ userId: "employee_a", threadId: "thread_a", text: "Я уверенно использую ИИ" });
    expect((await profiles.getProfile("employee_a"))?.aiLevel).toBe("advanced");
    expect((await profiles.getProfile("employee_b"))?.aiLevel).toBeUndefined();
  });

  it("replaces the recurring-task list on an explicit correction and appends otherwise", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyProfile(world, "employee_a", "invite_a");
    await profiles.updatePersonalContext({ employeeId: "employee_a", patch: { typicalTasks: ["Подготовка заявок", "Координация подрядчиков"] }, updatedAt: now });

    const appending = assistant({ world, profiles, runner: async (_input, context) => { await context.updatePersonalContext({ typicalTasks: ["Еженедельная отчётность"] }); return "ok"; } });
    await appending.chat({ userId: "employee_a", threadId: "thread_a", text: "Ещё каждую неделю собираю отчёт" });
    expect((await profiles.getProfile("employee_a"))?.typicalTasks)
      .toEqual(["Подготовка заявок", "Координация подрядчиков", "Еженедельная отчётность"]);

    const replacing = assistant({
      world, profiles,
      runner: async (_input, context) => {
        await context.updatePersonalContext({ typicalTasks: ["Координация подрядчиков", "Еженедельная отчётность"] }, { replaceTypicalTasks: true });
        return "ok";
      },
    });
    await replacing.chat({ userId: "employee_a", threadId: "thread_a", text: "Убери подготовку заявок из регулярных задач" });
    expect((await profiles.getProfile("employee_a"))?.typicalTasks).toEqual(["Координация подрядчиков", "Еженедельная отчётность"]);
    expect(world.auditEvents.filter((event) => event.type === "profile_updated").at(-1)?.metadata).toEqual({ changedFields: ["typicalTasks"] });
  });

  it("carries only an explicit replace request from the agent tool into the typed use-case", async () => {
    const calls: Array<{ patch: unknown; options: { replaceTypicalTasks: boolean } }> = [];
    const tool = createUpdatePersonalContextTool(async (patch, options) => {
      calls.push({ patch, options });
      return { changedFields: ["typicalTasks"] };
    });

    await tool.execute?.({ typicalTasks: ["Координация подрядчиков"], typicalTasksMode: "replace" }, {} as never);
    await tool.execute?.({ typicalTasks: ["Координация подрядчиков"] }, {} as never);

    expect(calls).toEqual([
      { patch: { typicalTasks: ["Координация подрядчиков"] }, options: { replaceTypicalTasks: true } },
      { patch: { typicalTasks: ["Координация подрядчиков"] }, options: { replaceTypicalTasks: false } },
    ]);
    expect(personalProfileContextPatchSchema.safeParse({ typicalTasks: ["Задача"], typicalTasksMode: "wipe" }).success).toBe(false);
    expect(personalProfileContextPatchSchema.safeParse({ typicalTasks: [], typicalTasksMode: "replace" }).success).toBe(false);
  });

  it("excludes personal context from participant/report projections and tool schemas stay bounded", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyProfile(world, "employee_a", "invite_a");
    await profiles.updatePersonalContext({ employeeId: "employee_a", patch: { typicalTasks: ["Закрытая личная задача"], aiLevel: "advanced", programGoal: "Закрытая личная цель" }, updatedAt: now });
    const page = await profiles.listParticipants({ companyId: "default_company", groupId: "default_group", limit: 10 });
    expect(JSON.stringify(page)).not.toMatch(/Закрытая|advanced|typicalTasks|programGoal|aiLevel/u);

    const activities = createInMemoryActivityCollectionState();
    const report = await new CompanyReportingService(createInMemoryCompanyReportStore({ participants: world.participants, activities }))
      .exportGroup({ companyId: "default_company", groupId: "default_group" });
    expect(JSON.stringify(report)).not.toMatch(/Закрытая|advanced|typicalTasks|programGoal|aiLevel/u);

    expect(personalProfileContextPatchSchema.safeParse({ typicalTasks: Array(8).fill("задача") }).success).toBe(false);
    expect(personalProfileContextPatchSchema.safeParse({ aiLevel: "expert" }).success).toBe(false);
    expect(personalProfileContextPatchSchema.safeParse({ programGoal: "x".repeat(501) }).success).toBe(false);
    const source = [
      readFileSync("src/application/company-reporting.ts", "utf8"),
      readFileSync("src/application/participant-engagement.ts", "utf8"),
      readFileSync("src/application/audit-event-store.ts", "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/programGoal|typicalTasks|aiLevel/u);
  });

  it("does not copy saved profile values into trace input, tool payloads, or outputs", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyProfile(world, "employee_a", "invite_a");
    const traces = createInMemoryResearchTraceStore(createInMemoryResearchTraceState());
    await profiles.updatePersonalContext({ employeeId: "employee_a", patch: { typicalTasks: ["Скрытая регулярная задача"], aiLevel: "advanced" }, updatedAt: now });
    const service = assistant({
      world, profiles, traces,
      runner: async (_input, context) => {
        await context.updatePersonalContext({ programGoal: "Скрытая цель профиля" });
        return {
          text: "Запомнил цель.",
          executionTrace: [{ kind: "tool", toolName: "updatePersonalContext" }],
          trace: {
            model: "test",
            modelSteps: [{ request: { toolName: "updatePersonalContext", args: { programGoal: "Скрытая цель профиля" } } }],
            toolCalls: [{ payload: { toolName: "updatePersonalContext", args: { programGoal: "Скрытая цель профиля" } } }],
            toolResults: [{ payload: { toolName: "updatePersonalContext", result: { changedFields: ["programGoal"] } } }],
          },
        };
      },
    });
    await service.chat({ userId: "employee_a", threadId: "thread_a", text: "Моя цель — меньше ручной рутины" });
    const [trace] = await traces.list({ companyId: "default_company", groupId: "default_group" });
    expect(JSON.stringify(trace)).not.toContain("Скрытая цель профиля");
    expect(trace?.attempts[0]?.context).not.toMatch(/Регулярные задачи:|Уровень знакомства с ИИ:|Личная цель программы:/u);
    expect(trace?.attempts[0]?.toolCalls).toEqual([{ payload: { toolName: "updatePersonalContext", args: { fields: ["programGoal"] } } }]);
    expect(trace?.input.text).toBe("Моя цель — меньше ручной рутины");
  });
});
