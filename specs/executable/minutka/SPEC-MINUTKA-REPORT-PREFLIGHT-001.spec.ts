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
    ["Иван Петров", "routine.name", "capitalized_pair", "high"],
    ["Иванович", "routine.name", "patronymic_suffix", "high"],
    ["ООО Ромашка", "routine.name", "organization_marker", "high"],
    ["Заявка 20261234", "routine.name", "long_number", "high"],
    ["Счёт 1200 ₽", "routine.name", "currency_amount", "high"],
    ["Письмо user@example.com", "routine.name", "email", "high"],
    ["Открыть https://example.com", "routine.name", "url", "high"],
    ["Написать @manager", "routine.name", "handle", "high"],
    ["Сделать «срочно»", "routine.name", "quote", "high"],
    ["Иван Петров", "routine.variants", "capitalized_pair", "medium"],
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

  it("accepts repeated one-contributor evidence as a group-level signal", () => {
    const routine = baseRoutine({ contributors: 1, observations: 4, activeDates: 4, confidence: "signal" });
    const client = {
      topRoutines: [{
        name: routine.name!,
        scope: "группа",
        evidenceSummary: { contributors: 1, observations: 4, activeDates: 4, estimatedHours: 1, unsizedObservations: 0 },
        systems: [],
        statedRecurrence: {},
        confidence: "signal" as const,
      }],
      frictionRoutines: [],
      firstSteps: [],
      deepDive: [],
      coverage: { assessment: "usable_with_limits", contributors: 1, activeDates: 4, observations: 4 } as ClientCompanyReport["coverage"],
    };

    expect(buildPreflightFindings({ ...report([routine]), client })).not.toContainEqual(expect.objectContaining({ rule: "rare_role" }));
  });

  it("flags a one-contributor routine when the client scope exposes a role", () => {
    const routine = baseRoutine({ contributors: 1, observations: 4, activeDates: 4, confidence: "signal" });
    const client = {
      topRoutines: [{
        name: routine.name!,
        scope: "Продажи",
        evidenceSummary: { contributors: 1, observations: 4, activeDates: 4, estimatedHours: 1, unsizedObservations: 0 },
        systems: [],
        statedRecurrence: {},
        confidence: "signal" as const,
      }],
      frictionRoutines: [],
      firstSteps: [],
      deepDive: [],
      coverage: { assessment: "usable_with_limits", contributors: 1, activeDates: 4, observations: 4 } as ClientCompanyReport["coverage"],
    };

    expect(buildPreflightFindings({ ...report([routine]), client })).toContainEqual(expect.objectContaining({ rule: "rare_role", severity: "low" }));
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
