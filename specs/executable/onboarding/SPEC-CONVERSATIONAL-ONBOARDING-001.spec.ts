import { describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { extractDeterministicOnboardingPatch, normalizeOnboardingProfilePatch, normalizeTimezone } from "../../../src/application/onboarding-profile-extractor.js";
import { timezoneSchema } from "../../../src/contracts/minutka-api.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createOnboardingContextMaterializer } from "../../../src/application/onboarding-context-materializer.js";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import type { DocumentStore } from "../../../src/application/document-store.js";

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

  it("supplies the confirmed owner's goals and projects to chat after a service restart", async () => {
    const runtime = await consentedRuntime("owner_restart");
    await runtime.service.submitOnboardingAnswer({ employeeId: "owner_restart", text: completeAnswer });
    await runtime.service.confirmOnboarding({ employeeId: "owner_restart" });

    const ingestion = createIngestionService({
      documentStore: runtime.documentStore,
      blobStore: createInMemoryBlobStore({ now: runtime.world.now }),
    });
    let ownerContext = "";
    const restartedService = new AssistantService(
      async (_input, context) => { ownerContext = context.systemContext; return "Контекст учтён."; },
      {
        documentStore: runtime.documentStore,
        conversationStore: createInMemoryConversationStore(runtime.world),
        ingestionService: ingestion,
        requestIntegrityGuard: async () => ({ status: "allowed" }),
        clock: { now: runtime.world.now },
      },
    );

    const ownerResult = await restartedService.chat({ userId: "owner_restart", threadId: "telegram:owner", text: "Какие у меня цели и проекты?" });
    expect(ownerResult.personalContextDocuments).toEqual(expect.arrayContaining([
      "/proc/context/10_user_memory/02_цели_и_приоритеты.md",
      "/proc/context/40_projects/00_проекты.md",
    ]));
    expect(ownerContext).toContain("# Цели и приоритеты");
    expect(ownerContext).toContain("# Проекты");

    let otherOwnerContext = "";
    const isolatedService = new AssistantService(
      async (_input, context) => { otherOwnerContext = context.systemContext; return "Контекста пока нет."; },
      {
        documentStore: runtime.documentStore,
        conversationStore: createInMemoryConversationStore(runtime.world),
        ingestionService: ingestion,
        requestIntegrityGuard: async () => ({ status: "allowed" }),
        clock: { now: runtime.world.now },
      },
    );
    const otherResult = await isolatedService.chat({ userId: "other_owner", threadId: "telegram:other", text: "Какие у меня цели и проекты?" });
    expect(otherResult.personalContextDocuments).toEqual([]);
    expect(otherOwnerContext).not.toContain("# Цели и приоритеты");
    expect(otherOwnerContext).not.toContain("# Проекты");
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

  it("does not infer unanswered choice fields from unrelated substrings", async () => {
    const namePatch = extractDeterministicOnboardingPatch({
      text: "Обычно меня зовут Саша",
      currentDraft: {
        employeeId: "emp_substrings",
        status: "collecting",
        pendingField: "preferredName",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-31T00:00:00.000Z",
      },
    });
    expect(namePatch).toMatchObject({ preferredName: "Саша" });
    expect(namePatch.responseLength).toBeUndefined();

    const runtime = await consentedRuntime("emp_substrings");
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_substrings", text: "Саша" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_substrings", text: "Спарк" });
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_substrings", text: "на тыловой стороне" })).resolves.toMatchObject({
      status: "needs_choice",
      field: "addressForm",
    });
    expect(runtime.world.onboardingDrafts[0].addressForm).toBeUndefined();
    expect(runtime.world.onboardingDrafts[0].persona).toBeUndefined();
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

  it("normalizes extractor names and rejects invalid timezone before saving the draft", async () => {
    expect(normalizeOnboardingProfilePatch({ preferredName: "   ", assistantName: "  Спарк  ", timezone: "Moscow", ambiguousFields: [] })).toEqual({
      assistantName: "Спарк",
      ambiguousFields: [],
    });

    const runtime = await consentedRuntime("emp_untrusted_patch");
    const extractedRuntime = createInMemoryRuntime({
      world: runtime.world,
      agentRunner: async () => "ok",
      deps: {
        onboardingProfileExtractor: async () => ({
          preferredName: "Максим",
          assistantName: "  Спарк  ",
          addressForm: "informal",
          persona: "efficiency",
          responseLength: "short",
          timezone: "Moscow",
          ambiguousFields: [],
        }),
      },
    });

    await expect(extractedRuntime.service.submitOnboardingAnswer({ employeeId: "emp_untrusted_patch", text: "данные профиля" })).resolves.toMatchObject({
      status: "needs_answer",
      field: "timezone",
    });
    expect(runtime.world.onboardingDrafts[0]).toMatchObject({
      preferredName: "Максим",
      assistantName: "Спарк",
      timezone: undefined,
      status: "collecting",
      pendingField: "timezone",
    });
  });

  it("canonicalizes valid IANA timezone casing at extractor, contract and service boundaries", async () => {
    expect(normalizeTimezone("europe/moscow")).toBe("Europe/Moscow");
    expect(normalizeTimezone("america/argentina/buenos_aires")).toBe("America/Buenos_Aires");
    expect(timezoneSchema.parse("europe/moscow")).toBe("Europe/Moscow");

    const runtime = await consentedRuntime("emp_canonical_tz");
    await expect(runtime.service.completeOnboarding({
      employeeId: "emp_canonical_tz",
      preferredName: "Максим",
      assistantName: "Спарк",
      addressForm: "informal",
      persona: "efficiency",
      responseLength: "short",
      timezone: "europe/moscow",
    })).resolves.toMatchObject({ profile: { timezone: "Europe/Moscow" } });
    expect(runtime.world.profiles[0].timezone).toBe("Europe/Moscow");
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

  it("recovers safely after partial context materialization without overwriting created documents", async () => {
    const world = createInMemoryWorld();
    const storedDocuments = createInMemoryDocumentStore({ now: world.now });
    let createAttempts = 0;
    let failAfterTwoCreates = true;
    const unreliableDocuments: DocumentStore = {
      ...storedDocuments,
      async putIfAbsent(userId, path, content) {
        createAttempts += 1;
        if (failAfterTwoCreates && createAttempts === 3) throw new Error("document store unavailable");
        return storedDocuments.putIfAbsent(userId, path, content);
      },
    };
    const ingestion = createIngestionService({
      documentStore: unreliableDocuments,
      blobStore: createInMemoryBlobStore({ now: world.now }),
    });
    const materializer = createOnboardingContextMaterializer({ documentStore: unreliableDocuments, ingestionService: ingestion });

    await expect(materializer.materialize({ userId: "owner_partial" })).rejects.toThrow("document store unavailable");
    const partiallyCreated = await storedDocuments.list("owner_partial", "context/");
    expect(partiallyCreated).toHaveLength(2);
    expect(partiallyCreated.map(({ version }) => version)).toEqual(["memory-1", "memory-2"]);

    failAfterTwoCreates = false;
    await expect(materializer.materialize({ userId: "owner_partial" })).resolves.toHaveLength(4);
    const recovered = await storedDocuments.list("owner_partial", "context/");
    expect(recovered).toHaveLength(4);
    expect(recovered.map(({ version }) => version)).toEqual(["memory-1", "memory-2", "memory-3", "memory-4"]);

    const existing = recovered[0];
    const ensured = await ingestion.ensureContextDocument({ userId: existing.userId, path: existing.path, content: "must not overwrite" });
    expect(ensured).toEqual(existing);
    expect((await storedDocuments.getExact(existing.userId, existing.path))?.content).toBe(existing.content);
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
