import { describe, expect, it } from "vitest";
import {
  buildPreflightFindings,
  preflightFindingId,
  type PreflightFinding,
} from "../../../src/application/report-preflight.js";
import type { ClientCompanyReport, InternalRoutine } from "../../../src/application/company-reporting.js";

const baseRoutine = (overrides: Partial<InternalRoutine> = {}): InternalRoutine => ({
  key: { roleId: "role_sales", routineKey: "подготовка отчётов" },
  name: "Подготовка отчётов",
  variants: [],
  contributors: 3,
  observations: 5,
  activeDates: 3,
  confidence: "confirmed",
  statedRecurrence: {},
  systems: [],
  taskCategories: [],
  estimatedHours: 5,
  unsizedObservations: 0,
  frictionSignals: { count: 0, byValue: {} },
  energySignals: { count: 0, byValue: {} },
  automationHypotheses: [],
  evidenceRefs: [],
  ...overrides,
});

function report(routines: InternalRoutine[]) {
  return {
    routines,
    buckets: [],
    roleContributors: { role_sales: 2 },
    coverage: {
      invitedParticipants: 2,
      subjects: 2,
      contributors: 3,
      observations: 5,
      activeDates: 3,
      unsizedObservations: 0,
      unattributedObservations: { count: 0, estimatedHours: 0, unsized: 0 },
    },
  };
}

function findingsFor(text: string, field: "routine.name" | "routine.variants" = "routine.name") {
  const routine = field === "routine.name"
    ? baseRoutine({ name: text })
    : baseRoutine({ variants: [text] });
  return buildPreflightFindings(report([routine])).filter((finding) => finding.field === field);
}

describe("SPEC-MINUTKA-REPORT-PREFLIGHT-001: deterministic report boundary preflight", () => {
  const cases: Array<[string, "routine.name" | "routine.variants", string, PreflightFinding["severity"]]> = [
    ["Звонок Иван Петров", "routine.name", "capitalized_pair", "high"],
    ["Иванович", "routine.name", "patronymic_suffix", "high"],
    ["ООО Ромашка", "routine.name", "organization_marker", "high"],
    ["Заявка 20261234", "routine.name", "long_number", "high"],
    ["Счёт 1200 ₽", "routine.name", "currency_amount", "high"],
    ["Письмо user@example.com", "routine.name", "email", "high"],
    ["Открыть https://example.com", "routine.name", "url", "high"],
    ["Написать @manager", "routine.name", "handle", "high"],
    ["Сделать «срочно»", "routine.name", "quote", "high"],
    ["Звонок Иван Петров", "routine.variants", "capitalized_pair", "medium"],
    ["Иванович", "routine.variants", "patronymic_suffix", "medium"],
    ["ООО Ромашка", "routine.variants", "organization_marker", "medium"],
    ["Заявка 20261234", "routine.variants", "long_number", "medium"],
    ["Счёт 1200 ₽", "routine.variants", "currency_amount", "medium"],
    ["Письмо user@example.com", "routine.variants", "email", "medium"],
    ["Открыть https://example.com", "routine.variants", "url", "medium"],
    ["Написать @manager", "routine.variants", "handle", "medium"],
    ["Сделать «срочно»", "routine.variants", "quote", "medium"],
  ];

  it.each(cases)("flags %s with one %s finding", (text, field, rule, severity) => {
    expect(findingsFor(text, field)).toEqual([
      expect.objectContaining({ field, rule, severity, excerpt: expect.any(String), id: expect.any(String) }),
    ]);
  });

  it("does not flag abbreviations or a title-case first word as a capitalized pair", () => {
    for (const text of ["Подготовка КП", "Обзвон CRM", "Сверка остатков 1С"]) {
      expect(findingsFor(text)).not.toContainEqual(expect.objectContaining({ rule: "capitalized_pair" }));
    }
  });

  it("flags title-case people names after a routine title", () => {
    for (const text of ["Звонок Иван Петров", "Согласование с Анной Ивановой"]) {
      expect(findingsFor(text)).toContainEqual(expect.objectContaining({ rule: "capitalized_pair", severity: "high" }));
    }
  });

  it("returns no findings for a clean name and variant", () => {
    expect(buildPreflightFindings(report([baseRoutine({ variants: ["подготовка отчётов"] })]))).toEqual([]);
  });

  it("flags a top-ten free routine as high but never fabricates one for unattributed observations", () => {
    const freeRoutine = baseRoutine({
      key: { roleId: "role_sales", routineKey: "свободная работа" },
      name: undefined,
      mostFrequentLabel: "свободная работа",
      estimatedHours: 10,
    });
    expect(buildPreflightFindings(report([freeRoutine])).filter(({ rule }) => rule === "unnamed_routine")).toEqual([
      expect.objectContaining({ field: "policy", routineKey: "свободная работа", severity: "high" }),
    ]);
    expect(buildPreflightFindings(report([]))).not.toContainEqual(expect.objectContaining({ rule: "unnamed_routine" }));
  });

  it("accepts one-contributor role scope when the client exposes only friction signals", () => {
    const routine = baseRoutine({
      contributors: 1,
      observations: 4,
      activeDates: 4,
      confidence: "signal",
      frictionSignals: { count: 1, byValue: { manual_reporting: 1 } },
      energySignals: { count: 1, byValue: { fatigue: 1 } },
    });
    const client = {
      topRoutines: [{
        name: routine.name!,
        scope: "Продажи",
        evidenceSummary: { contributors: 1, observations: 4, activeDates: 4, estimatedHours: 1, unsizedObservations: 0 },
        systems: [],
        statedRecurrence: {},
        confidence: "signal" as const,
      }],
      frictionRoutines: [{
        name: routine.name!,
        scope: "Продажи",
        signals: { manual_reporting: 1 },
        evidenceSummary: { contributors: 1, observations: 4, activeDates: 4, estimatedHours: 1, unsizedObservations: 0 },
        confidence: "signal" as const,
        deepDive: true as const,
      }],
      firstSteps: [],
      deepDive: [],
      coverage: { assessment: "usable_with_limits", contributors: 1, activeDates: 4, observations: 4 } as ClientCompanyReport["coverage"],
    };

    const findings = buildPreflightFindings({ ...report([routine]), client });
    expect(findings).not.toContainEqual(expect.objectContaining({ rule: "rare_role" }));
    expect(findings).not.toContainEqual(expect.objectContaining({ rule: "single_contributor_energy" }));
  });

  it("flags an energy signal exposed for a one-contributor client routine", () => {
    const routine = baseRoutine({
      contributors: 1,
      observations: 4,
      activeDates: 4,
      confidence: "signal",
      energySignals: { count: 1, byValue: { fatigue: 1 } },
    });
    const client = {
      topRoutines: [],
      frictionRoutines: [{
        name: routine.name!,
        scope: "Продажи",
        signals: { fatigue: 1 },
        evidenceSummary: { contributors: 1, observations: 4, activeDates: 4, estimatedHours: 1, unsizedObservations: 0 },
        confidence: "signal" as const,
        deepDive: true as const,
      }],
      firstSteps: [],
      deepDive: [],
      coverage: { assessment: "usable_with_limits", contributors: 1, activeDates: 4, observations: 4 } as ClientCompanyReport["coverage"],
    };

    const findings = buildPreflightFindings({ ...report([routine]), client });
    expect(findings).not.toContainEqual(expect.objectContaining({ rule: "rare_role" }));
    expect(findings).toContainEqual(expect.objectContaining({ rule: "single_contributor_energy", severity: "low", excerpt: "fatigue" }));
  });

  it("flags a client routine below the minimum observation threshold", () => {
    const routine = baseRoutine({ observations: 2, confidence: "signal" });
    const client = {
      topRoutines: [{
        name: routine.name!,
        scope: "группа",
        evidenceSummary: { contributors: 1, observations: 2, activeDates: 2, estimatedHours: 1, unsizedObservations: 0 },
        systems: [],
        statedRecurrence: {},
        confidence: "hypothesis" as const,
      }],
      frictionRoutines: [],
      firstSteps: [],
      deepDive: [],
      coverage: { assessment: "usable", contributors: 3, activeDates: 3, observations: 5 } as ClientCompanyReport["coverage"],
    };

    expect(buildPreflightFindings({ ...report([routine]), client })).toEqual([
      expect.objectContaining({ rule: "client_minimum_observations", severity: "low", excerpt: routine.name }),
    ]);
  });

  it("uses a stable content-addressed id and changes it when the excerpt changes", () => {
    const finding = { field: "routine.name" as const, routineKey: "role_sales:free", rule: "email", excerpt: "a@example.com" };
    expect(preflightFindingId(finding)).toBe(preflightFindingId(finding));
    expect(preflightFindingId(finding)).not.toBe(preflightFindingId({ ...finding, excerpt: "b@example.com" }));
  });
});
