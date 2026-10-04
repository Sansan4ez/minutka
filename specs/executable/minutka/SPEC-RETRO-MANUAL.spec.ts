import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";
import {
  assistantDiagnosticProcessIds,
  assistantScheduledProcessIds,
  ownerManagedScheduledProcessIds,
} from "../../../src/domain/assistant-process.js";

const manual = readFileSync("vault/assistant/processes/work_retrospective.md", "utf8");
const registry = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8")) as {
  processes: { id: string; path: string; appliesTo: string[] }[];
};

// Manual contract fixtures, not a substitute for T4b runtime routing or LLM evaluation.
// The stub checks the instructions required for a known dialogue outcome.
function stubGenerator(input: { instructions: string; text: string; policy: boolean }) {
  if (!input.policy || input.text === "Не хочу продолжать") {
    expect(input.instructions).toContain("no new retrospective questions or process writes");
    expect(input.instructions).toContain("refusal or a request to finish ends questioning");
    return { response: "Остановимся на том, что уже известно.", questions: [], writes: [] };
  }
  expect(input.instructions).toContain("If all four are present, go directly to the summary");
  expect(input.instructions).toContain("Already supplied stages are not asked again");
  return {
    response: "Вы рассказали: перенесли реквизиты из письма в договор; коллега принял результат после проверки. Вы хотите попробовать: список полей. Признак: возврат из-за пропуска → список неполон → поправить список.",
    questions: [],
    writes: [],
  };
}

describe("work_retrospective manual contracts", () => {
  it("SPEC-RETRO-MANUAL-01 loads the synchronized manual, registry and index without catalog drift", () => {
    const instructions = loadAssistantAgentInstructions();
    const entry = registry.processes.find(({ id }) => id === "work_retrospective");
    expect(entry?.path).toBe("vault/assistant/processes/work_retrospective.md");
    expect(instructions).toContain("## Process file: work_retrospective");
    expect(instructions).toContain("| `work_retrospective` |");
    expect(instructions).toContain("Preserve the single factual transaction before handoff");
    expect(instructions).toContain("after saving all facts offer a voluntary work_retrospective");
    for (const stage of ["Actions:", "Value:", "Future:", "Indicators:"]) expect(manual).toContain(stage);
    expect(manual).toContain("at most 4 additional questions");
    expect(manual).toContain("at most 8 additional questions only after explicit consent");
    expect(manual).toContain("applied/replayed");
    expect(manual).toContain("stale/not_found/forbidden");
  });

  it("SPEC-RETRO-MANUAL-02 is diagnostic and chat-only, never scheduled or owner-managed", () => {
    expect(assistantDiagnosticProcessIds).toContain("work_retrospective");
    expect(assistantScheduledProcessIds).not.toContain("work_retrospective");
    expect(ownerManagedScheduledProcessIds).not.toContain("work_retrospective");
    expect(registry.processes.find(({ id }) => id === "work_retrospective")?.appliesTo).toEqual(["chat"]);
  });

  it("SPEC-RETRO-MANUAL-03 rich four-stage dialogue fixture summarizes without a repeated questionnaire", () => {
    const result = stubGenerator({
      instructions: loadAssistantAgentInstructions(), policy: true,
      text: "Перенёс реквизиты из письма в договор. Коллега проверил и принял. Хочу попробовать список полей. Если вернут из-за пропуска, список неполон — поправлю его.",
    });
    expect(result.questions).toEqual([]);
    expect(result.response).toContain("Вы рассказали:");
    expect(result.response).toContain("Вы хотите попробовать:");
    expect(result.response).not.toContain("Возможная гипотеза");
  });

  it.each([
    { text: "Не хочу продолжать", policy: true },
    { text: "Давайте разберём договор", policy: false },
  ])("SPEC-RETRO-MANUAL-04 refusal/off routing fixture has no process questions or writes: %j", (fixture) => {
    const result = stubGenerator({ ...fixture, instructions: loadAssistantAgentInstructions() });
    expect(result.questions).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(manual).toContain("Missing policy/capabilities or enabled:false");
    expect(manual).toContain("Registration alone does not enable this method");
  });
});
