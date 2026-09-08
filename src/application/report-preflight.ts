import { createHash } from "node:crypto";
import { z } from "zod";
import type { EnergyStressMarkerType } from "../domain/insights.js";
import {
  energySignalValues,
  type ClientCompanyReport,
  type CompanyReportConfidence,
  type InternalCompanyEvidenceReport,
  type InternalRoutine,
} from "./company-reporting.js";

export const COMPANY_REPORT_CONFIDENCE_POLICY = {
  signalSubjects: 2,
  confirmedSubjects: 3,
  confirmedObservations: 5,
  confirmedDates: 3,
  clientMinimumObservations: 3,
} as const;

export type PreflightFinding = {
  id: string;
  field: "routine.name" | "routine.variants" | "policy";
  routineKey?: string;
  rule: string;
  excerpt: string;
  severity: "high" | "medium" | "low";
  reason?: string;
};

export const preflightFindingSchema = z.strictObject({
  id: z.string().min(1),
  field: z.enum(["routine.name", "routine.variants", "policy"]),
  routineKey: z.string().min(1).optional(),
  rule: z.string().min(1),
  excerpt: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  reason: z.string().min(1).max(500).optional(),
});

export const reportPreflightFindingsFileSchema = z.strictObject({
  schemaVersion: z.literal("minutka-report-preflight-findings/v1"),
  scope: z.string().trim().min(1),
  reportVersion: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(preflightFindingSchema),
});

export type ReportPreflightFindingsFile = z.infer<typeof reportPreflightFindingsFileSchema>;

type PreflightReport = Pick<InternalCompanyEvidenceReport, "routines" | "buckets" | "coverage"> & {
  client?: Pick<ClientCompanyReport, "topRoutines" | "frictionRoutines" | "firstSteps" | "deepDive" | "coverage">;
};

const lintRules: Array<{
  rule: string;
  pattern: RegExp;
}> = [
  { rule: "quote", pattern: /(?:"[^"\n]{1,200}"|«[^»\n]{1,200}»|„[^“\n]{1,200}“|“[^”\n]{1,200}”)/u },
  { rule: "email", pattern: /(?<![\p{L}\p{N}._%+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\p{L}\p{N}.-])/u },
  { rule: "url", pattern: /(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s]+/iu },
  { rule: "handle", pattern: /(?<![\p{L}\p{N}])@[\p{L}\p{N}_.-]+/u },
  { rule: "currency_amount", pattern: /(?:\d[\d\s.,]*\s?(?:₽|руб\.?|\$|€|тыс\.?))|(?:[$€]\s?\d[\d\s.,]*)/iu },
  { rule: "long_number", pattern: /(?<!\d)\d{4,}(?!\d)/u },
  { rule: "organization_marker", pattern: /(?<![\p{L}\p{N}])(?:ООО|ИП|АО|ЗАО|ПАО)(?![\p{L}\p{N}])/iu },
  { rule: "patronymic_suffix", pattern: /(?<![\p{L}])[\p{L}-]+(?:ович|евич|овна|евна|ич)(?![\p{L}])/iu },
  { rule: "capitalized_pair", pattern: /(?<![\p{L}])(?<!^)[\p{Lu}][\p{Ll}]+\s+[\p{Lu}][\p{Ll}]+(?![\p{L}])/u },
];

/**
 * Runs the report boundary checks without changing any source text. The
 * findings are deliberately derived from the report read model, so a second
 * run over the same activities and directory is byte-for-byte deterministic.
 */
export function buildPreflightFindings(report: PreflightReport): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const routine of report.routines) {
    const routineKey = routineIdentity(routine);
    if (routine.name !== undefined) {
      const match = lintText(routine.name);
      if (match !== undefined) findings.push(makeFinding("routine.name", routineKey, match.rule, match.excerpt, "high"));
    }
    for (const variant of routine.variants) {
      const match = lintText(variant);
      if (match !== undefined) findings.push(makeFinding("routine.variants", routineKey, match.rule, match.excerpt, "medium"));
    }

    const expectedConfidence = confidenceForCounts(routine.contributors, routine.observations, routine.activeDates);
    if (routine.confidence !== expectedConfidence) {
      findings.push(makeFinding("policy", routineKey, "confidence_policy", routine.confidence, "low"));
    }
  }

  const expectedAssessment = coverageAssessment(report.coverage);
  if (report.client !== undefined && report.client.coverage.assessment !== expectedAssessment) {
    findings.push(makeFinding("policy", undefined, "coverage_assessment", report.client.coverage.assessment, "low"));
  }

  if (report.client !== undefined) {
    for (const clientRoutine of report.client.frictionRoutines) {
      if (clientRoutine.evidenceSummary.contributors !== 1) continue;
      const exposedEnergySignal = Object.keys(clientRoutine.signals)
        .find((signal) => energySignalValues.has(signal as EnergyStressMarkerType));
      if (exposedEnergySignal === undefined) continue;
      const internalRoutine = report.routines.find((routine) => routine.name === clientRoutine.name && routine.contributors === 1);
      findings.push(makeFinding(
        "policy",
        internalRoutine === undefined ? undefined : routineIdentity(internalRoutine),
        "single_contributor_energy",
        exposedEnergySignal,
        "low",
      ));
    }

    const exposedRoutines = uniqueClientRoutines([
      ...report.client.topRoutines,
      ...report.client.frictionRoutines,
    ]);
    for (const clientRoutine of exposedRoutines) {
      if (clientRoutine.evidenceSummary.observations >= COMPANY_REPORT_CONFIDENCE_POLICY.clientMinimumObservations) continue;
      const internalRoutine = report.routines.find((routine) =>
        routine.name === clientRoutine.name
        && routine.observations === clientRoutine.evidenceSummary.observations
        && routine.contributors === clientRoutine.evidenceSummary.contributors
        && routine.activeDates === clientRoutine.evidenceSummary.activeDates);
      findings.push(makeFinding(
        "policy",
        internalRoutine === undefined ? undefined : routineIdentity(internalRoutine),
        "client_minimum_observations",
        clientRoutine.name,
        "low",
      ));
    }
  }

  for (const routine of report.routines.slice(0, 10)) {
    if (routine.name === undefined) {
      findings.push(makeFinding("policy", routineIdentity(routine), "unnamed_routine", routine.mostFrequentLabel ?? routineIdentity(routine), "high"));
    }
  }

  // Keep policy checks explicit even though the current builder already uses
  // these values. This catches regressions if another report producer is
  // introduced and feeds this module a malformed read model.
  for (const bucket of report.buckets) {
    if (bucket.confidence !== confidenceForCounts(bucket.contributors, bucket.observations, bucket.activeDates)) {
      findings.push(makeFinding("policy", undefined, "confidence_policy", bucket.confidence, "low"));
    }
    for (const facet of [...bucket.supportingEvidence.automationHypotheses, ...bucket.supportingEvidence.humanImpactSignals]) {
      if (facet.confidence !== confidenceForCounts(facet.contributors, facet.observations, facet.activeDates)) {
        findings.push(makeFinding("policy", undefined, "confidence_policy", facet.confidence, "low"));
      }
    }
  }

  return findings.sort((left, right) =>
    left.field.localeCompare(right.field)
    || (left.routineKey ?? "").localeCompare(right.routineKey ?? "")
    || left.rule.localeCompare(right.rule)
    || left.excerpt.localeCompare(right.excerpt),
  );
}

type ClientRoutineEvidence = Pick<ClientCompanyReport["topRoutines"][number], "name" | "scope" | "evidenceSummary">;

function uniqueClientRoutines(routines: ClientRoutineEvidence[]): ClientRoutineEvidence[] {
  return [...new Map(routines.map((routine) => [
    JSON.stringify([routine.name, routine.scope, routine.evidenceSummary]),
    routine,
  ])).values()];
}

export function hashClientReport(client: ClientCompanyReport): string {
  return createHash("sha256").update(JSON.stringify(client), "utf8").digest("hex");
}

export function preflightFindingId(input: Pick<PreflightFinding, "field" | "routineKey" | "rule" | "excerpt">): string {
  return createHash("sha256")
    .update(JSON.stringify([input.field, input.routineKey ?? null, input.rule, input.excerpt]), "utf8")
    .digest("hex");
}

function makeFinding(
  field: PreflightFinding["field"],
  routineKey: string | undefined,
  rule: string,
  excerpt: string,
  severity: PreflightFinding["severity"],
): PreflightFinding {
  const finding = { field, ...(routineKey === undefined ? {} : { routineKey }), rule, excerpt, severity } as Omit<PreflightFinding, "id">;
  return { id: preflightFindingId(finding), ...finding };
}

export function createPreflightFinding(
  field: PreflightFinding["field"],
  routineKey: string | undefined,
  rule: string,
  excerpt: string,
  severity: PreflightFinding["severity"],
  reason?: string,
): PreflightFinding {
  const finding = { field, ...(routineKey === undefined ? {} : { routineKey }), rule, excerpt, severity, ...(reason === undefined ? {} : { reason }) } as Omit<PreflightFinding, "id">;
  return { id: preflightFindingId(finding), ...finding };
}

function lintText(value: string): { rule: string; excerpt: string } | undefined {
  for (const { rule, pattern } of lintRules) {
    const match = value.match(pattern);
    if (match?.[0] !== undefined) return { rule, excerpt: match[0].trim() };
  }
  return undefined;
}

function routineIdentity(routine: InternalRoutine): string {
  return "routineKey" in routine.key ? routine.key.routineKey : routine.key.routineId;
}

export function confidenceForCounts(contributors: number, observations: number, activeDates: number): CompanyReportConfidence {
  if (
    contributors >= COMPANY_REPORT_CONFIDENCE_POLICY.confirmedSubjects
    && observations >= COMPANY_REPORT_CONFIDENCE_POLICY.confirmedObservations
    && activeDates >= COMPANY_REPORT_CONFIDENCE_POLICY.confirmedDates
  ) return "confirmed";
  if (contributors >= COMPANY_REPORT_CONFIDENCE_POLICY.signalSubjects || activeDates >= 2) return "signal";
  return "hypothesis";
}

function coverageAssessment(coverage: PreflightReport["coverage"]): ClientCompanyReport["coverage"]["assessment"] {
  if (coverage.observations === 0) return "insufficient";
  return coverage.contributors >= 3 && coverage.activeDates >= 3 ? "usable" : "usable_with_limits";
}
