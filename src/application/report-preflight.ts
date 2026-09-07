import { createHash } from "node:crypto";
import type {
  ClientCompanyReport,
  CompanyReportConfidence,
  InternalCompanyEvidenceReport,
  InternalRoutine,
} from "./company-reporting.js";

export const COMPANY_REPORT_CONFIDENCE_POLICY = {
  signalSubjects: 2,
  confirmedSubjects: 3,
  confirmedObservations: 5,
  confirmedDates: 3,
} as const;

export type PreflightFinding = {
  id: string;
  field: "routine.name" | "routine.variants" | "policy";
  routineKey?: string;
  rule: string;
  excerpt: string;
  severity: "high" | "medium" | "low";
};

type PreflightReport = Pick<InternalCompanyEvidenceReport, "routines" | "buckets" | "coverage"> & {
  client?: Pick<ClientCompanyReport, "topRoutines" | "frictionRoutines" | "coverage">;
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
  { rule: "capitalized_pair", pattern: /(?<![\p{L}])[\p{Lu}][\p{L}'’-]*\s+[\p{Lu}][\p{L}'’-]*(?![\p{L}])/u },
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

    const expectedConfidence = confidenceForEvidence(routine);
    if (routine.confidence !== expectedConfidence) {
      findings.push(makeFinding("policy", routineKey, "confidence_policy", routine.confidence, "low"));
    }
    if (routine.contributors < 2) {
      const clientRoutine = report.client === undefined || routine.name === undefined
        ? undefined
        : findClientRoutine(report.client, routine.name);
      if (routine.confidence !== "hypothesis" || (clientRoutine !== undefined && (clientRoutine.scope !== "группа" || clientRoutine.confidence !== "hypothesis"))) {
        findings.push(makeFinding("policy", routineKey, "rare_role", routine.name ?? routine.mostFrequentLabel ?? routineKey, "low"));
      }
    }
  }

  const expectedAssessment = coverageAssessment(report.coverage);
  if (report.client !== undefined && report.client.coverage.assessment !== expectedAssessment) {
    findings.push(makeFinding("policy", undefined, "coverage_assessment", report.client.coverage.assessment, "low"));
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

function confidenceForEvidence(routine: Pick<InternalRoutine, "contributors" | "observations" | "activeDates">): CompanyReportConfidence {
  return confidenceForCounts(routine.contributors, routine.observations, routine.activeDates);
}

function confidenceForCounts(contributors: number, observations: number, activeDates: number): CompanyReportConfidence {
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

function findClientRoutine(client: Pick<ClientCompanyReport, "topRoutines" | "frictionRoutines">, name: string): { scope: string; confidence: CompanyReportConfidence } | undefined {
  return [...client.topRoutines, ...client.frictionRoutines].find((routine) => routine.name === name);
}
