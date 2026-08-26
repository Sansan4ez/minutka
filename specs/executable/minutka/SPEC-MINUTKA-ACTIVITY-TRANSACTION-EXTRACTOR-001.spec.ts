import { Agent } from "@mastra/core/agent";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  activityTransactionDecisionSchema,
  activityTransactionExtractorInputSchema,
  createActivityTransactionExtractor,
  createActivityTransactionTransportSchema,
  normalizeActivityTransactionTransport,
} from "../../../src/application/activity-transaction-extractor.js";
import {
  activityTransactionContextBudget,
  buildActivityTransactionPrompt,
} from "../../../src/mastra/activity-transaction-extractor.js";
import { activityTransactionExtractorAgent } from "../../../src/mastra/agents/activity-transaction-extractor-agent.js";

const empty = {
  activities: [],
  handle: null,
  expectedRevision: null,
  correctionMode: null,
  correction: null,
  replacementHandle: null,
  replacementExpectedRevision: null,
} as const;
const nullPatch = {
  taskCategory: null,
  routinePattern: null,
  automationCandidate: null,
  energyStressMarker: null,
  system: null,
  durationRef: null,
} as const;

function transport(input: Record<string, unknown>) {
  return { reason: null, ...empty, ...input };
}

function extractorFor(object: unknown, observed: Array<{ prompt: string; schema: unknown }> = []) {
  return createActivityTransactionExtractor(async ({ prompt, outputSchema }) => {
    observed.push({ prompt, schema: outputSchema });
    return { object };
  }, buildActivityTransactionPrompt);
}

function recent(handle: string, revision = 1) {
  return {
    handle,
    revision,
    taskCategory: "reporting" as const,
    activityDate: "2026-08-26",
    recordedAt: "2026-08-26T09:00:00.000Z",
  };
}

describe("SPEC-MINUTKA-ACTIVITY-TRANSACTION-EXTRACTOR-001: strict bounded transaction decision", () => {
  it("normalizes all five outcomes and rejects impossible field combinations", () => {
    const outcomes = [
      transport({ kind: "none", reason: "no_factual_activity" }),
      transport({ kind: "needs_clarification", reason: "activity_status_ambiguous" }),
      transport({ kind: "collect", activities: [{ ...nullPatch, taskCategory: "meetings" }] }),
      transport({
        kind: "correct",
        handle: "activity_1",
        expectedRevision: 2,
        correctionMode: "patch",
        correction: { ...nullPatch, routinePattern: "waiting_for_input" },
      }),
      transport({
        kind: "supersede",
        handle: "activity_duplicate",
        expectedRevision: 1,
        replacementHandle: "activity_keep",
        replacementExpectedRevision: 3,
      }),
    ];

    expect(outcomes.map((outcome) => normalizeActivityTransactionTransport(outcome, []))).toEqual([
      { success: true, decision: { kind: "none", reason: "no_factual_activity" } },
      { success: true, decision: { kind: "needs_clarification", reason: "activity_status_ambiguous" } },
      { success: true, decision: { kind: "collect", activities: [{ taskCategory: "meetings" }] } },
      { success: true, decision: { kind: "correct", handle: "activity_1", expectedRevision: 2, mode: "patch", correction: { routinePattern: "waiting_for_input" } } },
      { success: true, decision: { kind: "supersede", handle: "activity_duplicate", expectedRevision: 1, replacementHandle: "activity_keep", replacementExpectedRevision: 3 } },
    ]);
    expect(normalizeActivityTransactionTransport(transport({
      kind: "collect",
      activities: [{ ...nullPatch, taskCategory: "reporting" }],
      handle: "impossible_handle",
    }), [])).toEqual({ success: false });
    expect(activityTransactionDecisionSchema.safeParse({ kind: "collect", activities: [{}] }).success).toBe(false);
    expect(activityTransactionDecisionSchema.safeParse({
      kind: "supersede", handle: "same", expectedRevision: 1, replacementHandle: "same", replacementExpectedRevision: 1,
    }).success).toBe(false);
  });

  it("keeps provider nullability at the transport boundary and rejects unknown facets/refs", () => {
    const schema = createActivityTransactionTransportSchema(["duration_1"]);
    const jsonSchema = schema.toJSONSchema({ io: "output", unrepresentable: "throw" });
    const validate = new Ajv2020({ strict: true }).compile(jsonSchema);
    expect(validate(transport({
      kind: "collect",
      activities: [{ ...nullPatch, taskCategory: "meetings", durationRef: "duration_1" }],
    }))).toBe(true);
    expect(validate(transport({
      kind: "collect",
      activities: [{ ...nullPatch, routinePattern: "invented_pattern" }],
    }))).toBe(false);
    expect(validate(transport({
      kind: "collect",
      activities: [{ ...nullPatch, durationRef: "invented_ref" }],
    }))).toBe(false);
    const zeroDurationSchema = createActivityTransactionTransportSchema([]).toJSONSchema({ io: "output", unrepresentable: "throw" });
    expect(JSON.stringify(zeroDurationSchema)).not.toContain("duration_1");
  });

  it("rejects mode-incompatible or invented repair targets before application code", async () => {
    await expect(extractorFor(transport({
      kind: "correct",
      handle: "invented_handle",
      expectedRevision: 7,
      correctionMode: "patch",
      correction: { ...nullPatch, taskCategory: "reporting" },
    }))({
      mode: "repair",
      currentText: "Исправь тот отчёт.",
      durationReferences: [],
      recentCandidates: [recent("activity_1")],
    })).resolves.toMatchObject({ status: "failed", code: "schema_error" });

    await expect(extractorFor(transport({
      kind: "collect",
      activities: [{ ...nullPatch, taskCategory: "reporting" }],
    }))({
      mode: "repair",
      currentText: "Исправь тот отчёт.",
      durationReferences: [],
      recentCandidates: [recent("activity_1")],
    })).resolves.toMatchObject({ status: "failed", code: "schema_error" });
  });

  it("uses one generation and typed provider/schema failures without semantic fallback", async () => {
    let calls = 0;
    const providerFailure = createActivityTransactionExtractor(async () => {
      calls += 1;
      throw new Error("provider unavailable");
    }, buildActivityTransactionPrompt);
    await expect(providerFailure({ mode: "record", currentText: "Завершил отчёт", durationReferences: [] }))
      .resolves.toMatchObject({ status: "failed", code: "provider_error" });
    expect(calls).toBe(1);

    const malformed = createActivityTransactionExtractor(async () => {
      calls += 1;
      return { object: { kind: "collect", activities: "not-an-array" } };
    }, buildActivityTransactionPrompt);
    await expect(malformed({ mode: "record", currentText: "Finished the report", durationReferences: [] }))
      .resolves.toMatchObject({ status: "failed", code: "schema_error" });
    expect(calls).toBe(2);
  });

  it("builds a measured prompt from only current text, static dictionaries, duration refs, and repair candidates", async () => {
    const observed: Array<{ prompt: string; schema: unknown }> = [];
    const input = {
      mode: "repair" as const,
      currentText: "El segundo registro es un duplicado del primero.",
      durationReferences: [],
      recentCandidates: [recent("activity_2"), recent("activity_1")],
    };
    await extractorFor(transport({
      kind: "supersede",
      handle: "activity_2",
      expectedRevision: 1,
      replacementHandle: "activity_1",
      replacementExpectedRevision: 1,
    }), observed)(input);

    expect(observed).toHaveLength(1);
    const prompt = observed[0]!.prompt;
    expect(prompt).toContain("El segundo registro es un duplicado del primero.");
    expect(prompt).toContain("activity_2");
    expect(prompt).toContain("durationBucket references resolve application-side");
    for (const forbidden of ["profile documents", "privacy policy", "company report", "schedule catalog", "tenant identity", "thread history", "subjectKey", "employeeId", "companyId", "groupId"]) {
      expect(prompt).not.toContain(forbidden);
    }
    const built = buildActivityTransactionPrompt(input);
    expect(built.context.currentTextCharacters).toBeGreaterThan(0);
    expect(built.context.staticRulesCharacters).toBeLessThanOrEqual(activityTransactionContextBudget.staticRulesCharacters);
    expect(built.context.recentCandidatesCharacters).toBeLessThanOrEqual(activityTransactionContextBudget.recentCandidatesCharacters);
    expect(built.context.promptCharacters).toBeGreaterThan(built.context.currentTextCharacters);
    expect(() => buildActivityTransactionPrompt({ ...input, recentCandidates: Array.from({ length: 6 }, (_, index) => recent(`activity_${index}`)) }))
      .toThrow(/recent activity candidates|Too big|too many/i);
    expect(activityTransactionExtractorInputSchema.safeParse({
      mode: "record", currentText: "Finished a report", durationReferences: [], recentCandidates: [recent("forbidden")],
    }).success).toBe(false);
  });

  it.each([
    ["ordinary Russian", "record", "Провёл встречу с поставщиком.", transport({ kind: "collect", activities: [{ ...nullPatch, taskCategory: "meetings" }] }), { kind: "collect", activities: [{ taskCategory: "meetings" }] }],
    ["ordinary English", "record", "Finished the monthly report in Excel.", transport({ kind: "collect", activities: [{ ...nullPatch, taskCategory: "reporting", system: "spreadsheets" }] }), { kind: "collect", activities: [{ taskCategory: "reporting", system: "spreadsheets" }] }],
    ["Russian correction", "repair", "Нет, в отчёте я ждал данные, а не переключался.", transport({ kind: "correct", handle: "activity_1", expectedRevision: 1, correctionMode: "patch", correction: { ...nullPatch, routinePattern: "waiting_for_input" } }), { kind: "correct", handle: "activity_1", expectedRevision: 1, mode: "patch", correction: { routinePattern: "waiting_for_input" } }],
    ["Spanish duplicate", "repair", "El segundo registro duplica el primero.", transport({ kind: "supersede", handle: "activity_2", expectedRevision: 1, replacementHandle: "activity_1", replacementExpectedRevision: 1 }), { kind: "supersede", handle: "activity_2", expectedRevision: 1, replacementHandle: "activity_1", replacementExpectedRevision: 1 }],
    ["repeated work", "record", "Ещё раз подготовил такой же отчёт для другого периода.", transport({ kind: "collect", activities: [{ ...nullPatch, taskCategory: "reporting" }] }), { kind: "collect", activities: [{ taskCategory: "reporting" }] }],
    ["ambiguity", "repair", "Исправь тот отчёт.", transport({ kind: "needs_clarification", reason: "correction_target_ambiguous" }), { kind: "needs_clarification", reason: "correction_target_ambiguous" }],
  ] as const)("normalizes the %s evaluation fixture", async (_label, mode, currentText, object, expected) => {
    const input = mode === "repair"
      ? { mode, currentText, durationReferences: [], recentCandidates: [recent("activity_2"), recent("activity_1")] }
      : { mode, currentText, durationReferences: [] };
    await expect(extractorFor(object)(input)).resolves.toMatchObject({ status: "completed", decision: expected });
  });

  it("sends one OpenAI-compatible structured request with toolChoice none and no tools", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const model = {
      specificationVersion: "v2",
      provider: "openai",
      modelId: "gpt-5.5",
      supportedUrls: {},
      async doGenerate(options: Record<string, unknown>) {
        calls.push(options);
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text", text: JSON.stringify(transport({ kind: "none", reason: "no_factual_activity" })) }],
          warnings: [],
        };
      },
      async doStream() { throw new Error("streaming is not used"); },
    } as never;
    const agent = new Agent({
      id: "activity-transaction-provider-probe",
      name: "activity-transaction-provider-probe",
      instructions: "Return the requested structure.",
      model,
      tools: {},
      editor: false,
    });

    await agent.generate("No factual activity", {
      structuredOutput: { schema: createActivityTransactionTransportSchema([]) },
      toolChoice: "none",
      maxSteps: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolChoice: { type: "none" }, providerOptions: { openai: { strictJsonSchema: true } } });
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.responseFormat).toMatchObject({ type: "json", schema: { type: "object", additionalProperties: false } });
    expect(await activityTransactionExtractorAgent.listTools()).toEqual({});
  });
});
