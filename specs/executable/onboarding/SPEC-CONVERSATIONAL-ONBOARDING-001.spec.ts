import { describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { extractDeterministicOnboardingPatch } from "../../../src/application/onboarding-profile-extractor.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createOnboardingContextMaterializer } from "../../../src/application/onboarding-context-materializer.js";

async function consentedRuntime(employeeId = "emp_conversational") {
  const world = createInMemoryWorld();
  const runtime = createInMemoryRuntime({ world, agentRunner: async () => "Добро пожаловать!" });
  await runtime.service.issueInvite({ employeeId, inviteCode: `invite_${employeeId}` });
  await runtime.service.openInvite({ inviteCode: `invite_${employeeId}` });
  await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
  return runtime;
}

const completeAnswer = "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow";

describe("SPEC-CONVERSATIONAL-ONBOARDING-001: minimal personal introduction", () => {
  it("collects the minimal profile in one message and writes only after confirmation", async () => {
    const runtime = await consentedRuntime();
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: completeAnswer })).toMatchObject({
      status: "needs_confirmation",
      summary: { preferredName: "Максим", assistantName: "Спарк", addressForm: "на ты", persona: "деловой", responseLength: "коротко", timezone: "Europe/Moscow" },
    });
    expect(runtime.world.profiles).toHaveLength(0);
    await runtime.service.confirmOnboarding({ employeeId: "emp_conversational" });
    expect(runtime.world.profiles[0]).toMatchObject({ preferredName: "Максим", assistantName: "Спарк", addressForm: "informal", persona: "efficiency", responseLength: "short", timezone: "Europe/Moscow" });
    expect(runtime.world.profiles[0].role).toBeUndefined();
    expect(runtime.world.profiles[0].typicalTasks).toBeUndefined();
    expect(runtime.world.profiles[0].aiLevel).toBeUndefined();
    expect(runtime.world.onboardingDrafts).toHaveLength(0);
  });

  it("materializes owner-scoped semantic context only after confirmation", async () => {
    const runtime = await consentedRuntime("owner_context");
    await runtime.service.submitOnboardingAnswer({ employeeId: "owner_context", text: completeAnswer });

    expect(await runtime.documentStore.list("owner_context", "context/")).toEqual([]);
    await runtime.service.confirmOnboarding({ employeeId: "owner_context" });

    const documents = await runtime.documentStore.list("owner_context", "context/");
    expect(documents.map(({ path }) => path)).toEqual([
      "context/10_user_memory/01_личная_конституция.md",
      "context/10_user_memory/02_цели_и_приоритеты.md",
      "context/40_projects/00_проекты.md",
      "context/90_agent_memory/soul.md",
    ]);
    expect(documents.find(({ path }) => path.endsWith("soul.md"))?.content).toContain("не определяет роль, полномочия");
    expect(JSON.stringify(documents)).not.toContain("context/imported-knowledge-base");
    expect(await runtime.documentStore.list("other_owner", "context/")).toEqual([]);
  });

  it("preserves imported semantic documents instead of creating competing onboarding copies", async () => {
    const runtime = await consentedRuntime("owner_imported");
    await runtime.documentStore.put(
      "owner_imported",
      "context/imported-knowledge-base/10_user_memory/01_Persona.md",
      "# Existing constitution",
    );
    await runtime.service.submitOnboardingAnswer({ employeeId: "owner_imported", text: completeAnswer });
    await runtime.service.confirmOnboarding({ employeeId: "owner_imported" });

    expect(await runtime.documentStore.getExact("owner_imported", "context/10_user_memory/01_личная_конституция.md")).toBeNull();
    expect(await runtime.documentStore.get("owner_imported", "context/10_user_memory/01_Persona.md")).toMatchObject({
      path: "context/10_user_memory/01_Persona.md",
      content: "# Existing constitution",
    });
  });

  it("asks at most one next question and accepts partial answers", async () => {
    const runtime = await consentedRuntime();
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Максим" })).toMatchObject({ status: "needs_answer", field: "assistantName" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Спарк" })).toMatchObject({ status: "needs_choice", field: "addressForm" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "informal" })).toMatchObject({ status: "needs_choice", field: "persona" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "efficiency" })).toMatchObject({ status: "needs_choice", field: "responseLength" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "short" })).toMatchObject({ status: "needs_answer", field: "timezone" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Europe/Moscow" })).toMatchObject({ status: "needs_confirmation" });
  });

  it("does not overwrite collected values before confirmation and accepts explicit corrections after the summary", async () => {
    const runtime = await consentedRuntime();
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Максим" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Алексей" });
    expect(runtime.world.onboardingDrafts[0].preferredName).toBe("Максим");

    await runtime.service.resetOnboardingDraft({ employeeId: "emp_conversational" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: completeAnswer });
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Нет" })).resolves.toMatchObject({ status: "needs_correction" });
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Зови меня Алексей" })).resolves.toMatchObject({
      status: "needs_confirmation", summary: { preferredName: "Алексей", assistantName: "Спарк" },
    });
  });

  it("validates IANA timezone and falls back deterministically when the extractor fails", async () => {
    const invalid = await consentedRuntime("emp_invalid_tz");
    await invalid.service.submitOnboardingAnswer({ employeeId: "emp_invalid_tz", text: "Максим | Спарк | На ты | Деловой | Коротко | Moscow" });
    expect(invalid.world.onboardingDrafts[0].timezone).toBeUndefined();
    expect(invalid.world.onboardingDrafts[0].pendingField).toBe("timezone");

    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok", deps: { onboardingProfileExtractor: async () => { throw new Error("provider unavailable"); } } });
    await runtime.service.issueInvite({ employeeId: "emp_fallback", inviteCode: "invite_fallback" });
    await runtime.service.openInvite({ inviteCode: "invite_fallback" });
    await runtime.service.acceptConsent({ employeeId: "emp_fallback", accepted: true, source: "test" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_fallback", text: completeAnswer })).toMatchObject({ status: "needs_confirmation" });
  });

  it("makes repeated confirmation idempotent without duplicate documents, audit facts or agent runs", async () => {
    let agentRuns = 0;
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => { agentRuns += 1; return "ok"; } });
    await runtime.service.issueInvite({ employeeId: "emp_confirm", inviteCode: "invite_confirm" });
    await runtime.service.openInvite({ inviteCode: "invite_confirm" });
    await runtime.service.acceptConsent({ employeeId: "emp_confirm", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_confirm", text: completeAnswer });
    await Promise.all([runtime.service.confirmOnboarding({ employeeId: "emp_confirm" }), runtime.service.confirmOnboarding({ employeeId: "emp_confirm" })]);
    expect(agentRuns).toBe(1);
    expect(world.auditEvents.filter((event) => event.type === "profile_updated")).toHaveLength(1);
    expect(world.auditEvents.filter((event) => event.type === "onboarding_completed")).toHaveLength(1);
    expect((await runtime.documentStore.list("emp_confirm", "context/")).map(({ version }) => version)).toEqual([
      "memory-1", "memory-2", "memory-3", "memory-4",
    ]);
  });

  it("keeps confirmation retryable when context storage fails", async () => {
    const world = createInMemoryWorld();
    const clock = { now: world.now };
    const documents = createInMemoryDocumentStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) });
    const reliableMaterializer = createOnboardingContextMaterializer({ documentStore: documents, ingestionService: ingestion });
    let fail = true;
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: async () => "ok",
      deps: {
        onboardingContextMaterializer: {
          async materialize(input) {
            if (fail) throw new Error("document store unavailable");
            return reliableMaterializer.materialize(input);
          },
        },
      },
    });
    await runtime.service.issueInvite({ employeeId: "emp_recovery", inviteCode: "invite_recovery" });
    await runtime.service.openInvite({ inviteCode: "invite_recovery" });
    await runtime.service.acceptConsent({ employeeId: "emp_recovery", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_recovery", text: completeAnswer });

    await expect(runtime.service.confirmOnboarding({ employeeId: "emp_recovery" })).rejects.toThrow("document store unavailable");
    expect(world.profiles).toHaveLength(0);
    expect(world.participants.find(({ employeeId }) => employeeId === "emp_recovery")?.status).toBe("consent_accepted");
    expect(world.onboardingDrafts).toHaveLength(1);

    fail = false;
    await expect(runtime.service.confirmOnboarding({ employeeId: "emp_recovery" })).resolves.toMatchObject({ status: "profile_completed" });
    expect(await documents.list("emp_recovery", "context/")).toHaveLength(4);
  });

  it("does not recreate a draft when confirmation completes during extraction", async () => {
    let extractionStarted!: () => void;
    let releaseExtraction!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: async () => "ok",
      deps: { onboardingProfileExtractor: async (input) => { if (input.text === "Зови меня Алексей") { extractionStarted(); await release; } return extractDeterministicOnboardingPatch(input); } },
    });
    await runtime.service.issueInvite({ employeeId: "emp_race", inviteCode: "invite_race" });
    await runtime.service.openInvite({ inviteCode: "invite_race" });
    await runtime.service.acceptConsent({ employeeId: "emp_race", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_race", text: completeAnswer });
    const staleAnswer = runtime.service.submitOnboardingAnswer({ employeeId: "emp_race", text: "Зови меня Алексей" });
    await started;
    await runtime.service.confirmOnboarding({ employeeId: "emp_race" });
    releaseExtraction();
    await expect(staleAnswer).rejects.toMatchObject({ code: "profile_already_completed" });
    expect(world.onboardingDrafts).toHaveLength(0);
  });
});
