import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ReportPreflightLlmError,
  ReportPreflightLlmService,
  type ReportPreflightLlmGenerator,
} from "../../../src/application/report-preflight-llm.js";
import { hashClientReport } from "../../../src/application/report-preflight.js";
import { buildReportPreflightLlmPrompt } from "../../../src/mastra/report-preflight-checker.js";
import { runCompanyReportCommand } from "../../../src/runtime/company-report-command.js";

const routines = [
  { routineKey: "role_sales:manager_kazakhstan", name: "Единственный менеджер по Казахстану", variants: ["работа с Казахстаном"] },
  { routineKey: "role_sales:reports", name: "Подготовка отчётов", variants: ["сверка таблиц"] },
];

function generatorReturning(object: unknown, prompts: string[]): ReportPreflightLlmGenerator {
  return async ({ routines }) => {
    prompts.push(buildReportPreflightLlmPrompt({ routines }));
    return { object };
  };
}

describe("SPEC-MINUTKA-REPORT-PREFLIGHT-LLM-001: semantic report boundary preflight", () => {
  it("turns a flagged routine into a high finding with a reason and does not change the name", async () => {
    const prompts: string[] = [];
    const input = routines.map((routine) => ({ ...routine, variants: [...routine.variants] }));
    const findings = await new ReportPreflightLlmService(generatorReturning({
      results: [
        { routineKey: routines[0]!.routineKey, verdict: "flag", reason: "Указывает на редкое сочетание роли и территории." },
        { routineKey: routines[1]!.routineKey, verdict: "ok", reason: "" },
      ],
    }, prompts)).check({ routines: input });

    expect(findings).toEqual([expect.objectContaining({
      field: "routine.name",
      routineKey: routines[0]!.routineKey,
      rule: "llm_identifying_detail",
      severity: "high",
      excerpt: routines[0]!.name,
      reason: "Указывает на редкое сочетание роли и территории.",
      id: expect.any(String),
    })]);
    expect(input).toEqual(routines);
    expect(prompts[0]).not.toContain("subjectKey");
    expect(prompts[0]).not.toContain("evidenceRefs");
    expect(prompts[0]).not.toContain("messages");
    expect(prompts[0]).toContain(routines[0]!.name);
    expect(prompts[0]).toContain(routines[0]!.variants[0]!);
  });

  it("returns no findings when every routine is safe", async () => {
    const findings = await new ReportPreflightLlmService(generatorReturning({
      results: routines.map(({ routineKey }) => ({ routineKey, verdict: "ok" as const, reason: "" })),
    }, [])).check({ routines });
    expect(findings).toEqual([]);
  });

  it("uses the versioned prompt and rejects a malformed model response as a typed error", async () => {
    expect(buildReportPreflightLlmPrompt({ routines })).toContain("minutka-report-preflight/v1");
    await expect(new ReportPreflightLlmService(generatorReturning({ results: [{ routineKey: routines[0]!.routineKey, verdict: "flag" }] }, [])).check({ routines }))
      .rejects.toBeInstanceOf(ReportPreflightLlmError);
    await expect(new ReportPreflightLlmService(generatorReturning({ results: [] }, [])).check({ routines }))
      .rejects.toMatchObject({ code: "invalid_model_response", findings: [] });
  });

  it("prints the deterministic and semantic findings together and writes no output on model failure", async () => {
    const writes: string[] = [];
    const report = {
      internal: {
        routines: routines.map((routine) => ({
          key: { roleId: "role_sales", routineKey: routine.routineKey },
          name: routine.name,
          variants: routine.variants,
        })),
        preflightFindings: [{
          id: "lint-id", field: "routine.name" as const, routineKey: routines[1]!.routineKey,
          rule: "quote", excerpt: "«срочно»", severity: "high" as const,
        }],
      },
      client: {} as never,
    };
    const directory = mkdtempSync(join(tmpdir(), "minutka-preflight-llm-"));
    const directoryFile = join(directory, "directory.json");
    writeFileSync(directoryFile, JSON.stringify({ schemaVersion: "minutka-routine-directory/v1", companyId: "company_a", version: "1", sections: [] }));
    try {
      await runCompanyReportCommand(["preflight-llm", "--company", "company_a", "--group", "group_a", "--directory", directoryFile], {
        reporting: { async buildReport() { return report as never; } },
        checkLlm: generatorReturning({ results: [
          { routineKey: routines[0]!.routineKey, verdict: "flag", reason: "Редкое сочетание." },
          { routineKey: routines[1]!.routineKey, verdict: "ok", reason: "" },
        ] }, []),
      }, (text) => writes.push(text));
      expect(JSON.parse(writes[0] ?? "{}")).toEqual(expect.objectContaining({
        schemaVersion: "minutka-report-preflight-findings/v1",
        scope: "company_a/group_a",
        reportVersion: hashClientReport(report.client),
        findings: expect.arrayContaining([
          expect.objectContaining({ rule: "quote" }),
          expect.objectContaining({ rule: "llm_identifying_detail", reason: "Редкое сочетание." }),
        ]),
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not write an output file when the provider fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minutka-preflight-llm-failure-"));
    const directoryFile = join(directory, "directory.json");
    const outputFile = join(directory, "findings.json");
    writeFileSync(directoryFile, JSON.stringify({ schemaVersion: "minutka-routine-directory/v1", companyId: "company_a", version: "1", sections: [] }));
    try {
      await expect(runCompanyReportCommand(["preflight-llm", "--company", "company_a", "--group", "group_a", "--directory", directoryFile, "--out", outputFile], {
        reporting: { async buildReport() { return { internal: { routines: [{ key: { roleId: "role_sales", routineKey: "reports" }, name: "Подготовка отчётов", variants: [] }], preflightFindings: [] }, client: {} } as never; } },
        checkLlm: async () => { throw new Error("provider unavailable"); },
      })).rejects.toThrow("provider unavailable");
      expect(() => statSync(outputFile)).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
