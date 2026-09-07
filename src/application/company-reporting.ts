import type { PersonalActivityRecord } from "./activity-collection.js";
import type { ActivityDurationBucket, ActivityRecurrence, ActivitySystem, AutomationCandidateType, EnergyStressMarkerType, RoutinePatternType, TaskCategory } from "../domain/insights.js";
import { loadRoutineDirectory, type RoutineDirectory, type RoutineDirectoryEntry } from "./routine-directory.js";
import { findQuickWin, type QuickWinId } from "./quick-wins.js";
import { routineKey, tally } from "./own-activity-window.js";
import { buildPreflightFindings, COMPANY_REPORT_CONFIDENCE_POLICY } from "./report-preflight.js";

export { COMPANY_REPORT_CONFIDENCE_POLICY } from "./report-preflight.js";

export const durationBucketHours: Record<ActivityDurationBucket, number> = {
  lt_15m: 0.2,
  "15_30m": 0.4,
  "30_60m": 0.75,
  "1_2h": 1.5,
  "2_4h": 3,
  gt_4h: 5,
};

export type CompanyReportConfidence = "hypothesis" | "signal" | "confirmed";
export type CompanyReportEvidenceRef = { kind: "activity"; id: string; subjectKey: string };
export type CompanyReportProcessKey = {
  taskCategory?: TaskCategory;
  routinePattern?: RoutinePatternType;
};
export type InternalSupportingFacet<T extends string> = {
  value: T;
  contributors: number;
  observations: number;
  activeDates: number;
  confidence: CompanyReportConfidence;
  evidenceRefs: CompanyReportEvidenceRef[];
};

export type CompanyReportSnapshot = {
  invitedParticipants: number;
  subjects: Array<{ subjectKey: string; roleId?: string }>;
  activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>;
  reference?: {
    companyLabel: string;
    groupLabel: string;
    period: { start: string; end: string };
    roleLabels: Record<string, string>;
  };
};

export type CompanyReportStore = {
  loadGroupSnapshot(input: { companyId: string; groupId: string }): Promise<CompanyReportSnapshot>;
};

const frictionSignalValues = new Set<RoutinePatternType>([
  "manual_reporting", "coordination_overhead", "context_switching", "waiting_for_input", "meeting_overload", "unclear_priority",
]);
const energySignalValues = new Set<EnergyStressMarkerType>(["frustration", "fatigue", "overload", "focus_loss", "blocked_progress"]);

export type InternalEvidenceBucket = {
  bucketId: string;
  scope: { kind: "overall_group" } | { kind: "role"; roleId: string };
  process: CompanyReportProcessKey;
  systems: ActivitySystem[];
  durationBuckets: ActivityDurationBucket[];
  contributors: number;
  observations: number;
  activeDates: number;
  confidence: CompanyReportConfidence;
  supportingEvidence: {
    automationHypotheses: Array<InternalSupportingFacet<AutomationCandidateType>>;
    humanImpactSignals: Array<InternalSupportingFacet<EnergyStressMarkerType>>;
  };
  evidenceRefs: CompanyReportEvidenceRef[];
};

export type InternalTimeBudgetEntry = {
  taskCategory?: TaskCategory;
  estimatedHours: number;
  share: number;
  contributors: number;
  observations: number;
  unsizedObservations: number;
};

export type InternalRoutineKey =
  | { roleId: string; routineId: string }
  | { roleId: string; routineKey: string };

export type InternalRoutineSignal = {
  count: number;
  byValue: Partial<Record<RoutinePatternType | EnergyStressMarkerType, number>>;
};

export type InternalRoutine = {
  key: InternalRoutineKey;
  name?: string;
  mostFrequentLabel?: string;
  variants: string[];
  contributors: number;
  observations: number;
  activeDates: number;
  confidence: CompanyReportConfidence;
  statedRecurrence: Partial<Record<ActivityRecurrence, number>>;
  systems: ActivitySystem[];
  taskCategories: TaskCategory[];
  estimatedHours: number;
  unsizedObservations: number;
  frictionSignals: InternalRoutineSignal;
  energySignals: InternalRoutineSignal;
  automationHypotheses: Array<InternalSupportingFacet<AutomationCandidateType>>;
  quickWin?: QuickWinId | "deep_dive";
  evidenceRefs: CompanyReportEvidenceRef[];
};

export type InternalCompanyEvidenceReport = {
  schemaVersion: "minutka-internal-report/v2";
  generatedAt: string;
  companyId: string;
  groupId: string;
  directoryVersion?: string;
  reference?: CompanyReportSnapshot["reference"];
  period: { start: string; end: string };
  roleContributors: Record<string, number>;
  coverage: {
    invitedParticipants: number;
    subjects: number;
    contributors: number;
    observations: number;
    activeDates: number;
    unsizedObservations: number;
    unattributedObservations: {
      count: number;
      estimatedHours: number;
      unsized: number;
    };
  };
  timeBudget: InternalTimeBudgetEntry[];
  routines: InternalRoutine[];
  preflightFindings: import("./report-preflight.js").PreflightFinding[];
  buckets: InternalEvidenceBucket[];
};

export type ClientRoutineEvidenceSummary = {
  contributors: number;
  observations: number;
  activeDates: number;
  estimatedHours: number;
  unsizedObservations: number;
};

export type ClientQuickWin = NonNullable<ReturnType<typeof findQuickWin>>;

export type ClientRoutine = {
  name: string;
  scope: string;
  evidenceSummary: ClientRoutineEvidenceSummary;
  systems: string[];
  statedRecurrence: Partial<Record<ActivityRecurrence, number>>;
  confidence: CompanyReportConfidence;
  quickWin?: ClientQuickWin;
  deepDive?: true;
  question?: string;
};

export type ClientFrictionRoutine = {
  name: string;
  scope: string;
  signals: Partial<Record<RoutinePatternType | EnergyStressMarkerType, number>>;
  evidenceSummary: ClientRoutineEvidenceSummary;
  confidence: CompanyReportConfidence;
  quickWin?: ClientQuickWin;
  deepDive?: true;
};

export type ClientCompanyReport = {
  schemaVersion: "minutka-client-report.v2";
  title: string;
  companyLabel: string;
  groupLabel: string;
  period: { start: string; end: string };
  coverage: {
    assessment: "insufficient" | "usable_with_limits" | "usable";
    invitedParticipants: number;
    contributors: number;
    activeDates: number;
    observations: number;
    unsizedObservations: number;
    unattributedObservations: number;
    coveredRoles: string[];
    limitations: string[];
  };
  timeBudget: InternalTimeBudgetEntry[];
  topRoutines: ClientRoutine[];
  frictionRoutines: ClientFrictionRoutine[];
  firstSteps: Array<{ routine: string; firstStep: string; effort: "hours" | "days" | "weeks"; whoCanDo: string }>;
  deepDive: Array<{ name: string; scope: string; question: string; reason: string }>;
  cannotConclude: string[];
};

export type CompanyReportResult = {
  internal: InternalCompanyEvidenceReport;
  client: ClientCompanyReport;
};

/**
 * Subject-aware canonical report use-case. It reads current private activities
 * on every call, so corrections and purges are reflected without a materialized
 * reporting copy. The client DTO is built separately from the internal DTO.
 */
export class CompanyReportingService {
  constructor(
    private readonly store: CompanyReportStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async buildReport(input: { companyId: string; groupId: string; directory?: unknown }): Promise<CompanyReportResult> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");

    const directory = input.directory === undefined
      ? undefined
      : loadRoutineDirectory(input.directory, { expectedCompanyId: companyId });
    const snapshot = await this.store.loadGroupSnapshot({ companyId, groupId });
    assertExactScope(companyId, groupId, snapshot);
    const subjectKeys = new Set(snapshot.subjects.map((subject) => subject.subjectKey));
    const activities = snapshot.activities.filter((activity) => subjectKeys.has(activity.subjectKey));
    const internal = buildInternalReport(companyId, groupId, snapshot.invitedParticipants, snapshot.subjects.length, activities, this.now(), directory, snapshot.reference);
    return { internal, client: buildClientReport(internal) };
  }

  async exportGroup(input: { companyId: string; groupId: string; directory?: unknown }): Promise<CompanyReportResult> {
    return this.buildReport(input);
  }
}

export function confidenceForEvidence(input: { contributors: number; observations: number; activeDates: number }): CompanyReportConfidence {
  if (
    input.contributors >= COMPANY_REPORT_CONFIDENCE_POLICY.confirmedSubjects
    && input.observations >= COMPANY_REPORT_CONFIDENCE_POLICY.confirmedObservations
    && input.activeDates >= COMPANY_REPORT_CONFIDENCE_POLICY.confirmedDates
  ) return "confirmed";
  if (input.contributors >= COMPANY_REPORT_CONFIDENCE_POLICY.signalSubjects || input.activeDates >= 2) return "signal";
  return "hypothesis";
}

function buildInternalReport(
  companyId: string,
  groupId: string,
  invitedParticipants: number,
  subjectCount: number,
  activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>,
  generatedAt: string,
  directory?: RoutineDirectory,
  reference?: CompanyReportSnapshot["reference"],
): InternalCompanyEvidenceReport {
  const contributors = new Set(activities.map((activity) => activity.subjectKey)).size;
  const roleContributors = Object.fromEntries(
    [...groupBy(activities, (activity) => activity.roleId).entries()]
      .map(([roleId, roleActivities]) => [roleId, new Set(roleActivities.map((activity) => activity.subjectKey)).size]),
  );
  const activeDates = new Set(activities.map((activity) => activity.activityDate)).size;
  const classified = classifyActivities(activities, directory);
  const attributedActivities = classified.filter(({ routine }) => routine !== undefined).map(({ activity }) => activity);
  const unattributedActivities = classified.filter(({ routine }) => routine === undefined).map(({ activity }) => activity);
  const report: InternalCompanyEvidenceReport = {
    schemaVersion: "minutka-internal-report/v2",
    generatedAt,
    companyId,
    groupId,
    ...(directory === undefined ? {} : { directoryVersion: directory.version }),
    ...(reference === undefined ? {} : { reference }),
    period: reference?.period ?? periodForActivities(activities, generatedAt),
    roleContributors,
    coverage: {
      invitedParticipants,
      subjects: subjectCount,
      contributors,
      observations: activities.length,
      activeDates,
      unsizedObservations: activities.filter((activity) => activity.durationBucket === undefined).length,
      unattributedObservations: observationCoverage(unattributedActivities),
    },
    timeBudget: buildTimeBudget(attributedActivities),
    routines: buildRoutines(classified.filter(({ routine }) => routine !== undefined) as ClassifiedActivity[]),
    preflightFindings: [],
    buckets: [
      ...buildBuckets({ kind: "overall_group" }, attributedActivities),
      ...[...groupBy(attributedActivities, (activity) => activity.roleId).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([roleId, roleActivities]) => buildBuckets({ kind: "role", roleId }, roleActivities)),
    ],
  };
  report.preflightFindings = buildPreflightFindings({ ...report, client: buildClientReport(report) });
  return report;
}

type ReportActivity = Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">;
type ClassifiedActivity = { activity: ReportActivity; routine?: RoutineDescriptor };
type RoutineDescriptor = {
  key: InternalRoutineKey;
  entry?: RoutineDirectoryEntry;
};

function classifyActivities(activities: ReportActivity[], directory?: RoutineDirectory): ClassifiedActivity[] {
  return activities.map((activity) => {
    const entry = activity.routineId === undefined || directory === undefined
      ? undefined
      : directory.sections.find((section) => section.roleId === activity.roleId)?.entries.find(({ id }) => id === activity.routineId);
    if (entry !== undefined) return { activity, routine: { key: { roleId: activity.roleId, routineId: entry.id }, entry } };
    if (activity.routineLabel !== undefined) {
      return { activity, routine: { key: { roleId: activity.roleId, routineKey: routineKey(activity.routineLabel) }, ...(activity.routineId === undefined || directory === undefined ? {} : {}) } };
    }
    return { activity };
  });
}

function buildRoutines(classified: ClassifiedActivity[]): InternalRoutine[] {
  const groups = new Map<string, ClassifiedActivity[]>();
  for (const item of classified) {
    if (item.routine === undefined) continue;
    const key = JSON.stringify(item.routine.key);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((items) => {
    const descriptor = items[0]!.routine!;
    const activities = items.map(({ activity }) => activity);
    const labels = tallyLabels(activities.flatMap(({ routineLabel }) => routineLabel === undefined ? [] : [routineLabel]));
    const contributors = new Set(activities.map(({ subjectKey }) => subjectKey)).size;
    const observations = activities.length;
    const activeDates = new Set(activities.map(({ activityDate }) => activityDate)).size;
    const friction = tallySignals(activities, (activity) => activity.routinePattern, frictionSignalValues);
    const energy = tallySignals(activities, (activity) => activity.energyStressMarker, energySignalValues);
    const automationHypotheses = buildSupportingFacets(activities, (activity) => activity.automationCandidate);
    const routine: InternalRoutine = {
      key: descriptor.key,
      ...(descriptor.entry === undefined ? {} : { name: descriptor.entry.name }),
      ...(labels[0] === undefined ? {} : { mostFrequentLabel: labels[0].value }),
      variants: uniqueSorted(activities.flatMap(({ routineLabel }) => routineLabel === undefined ? [] : [routineLabel])),
      contributors,
      observations,
      activeDates,
      confidence: confidenceForEvidence({ contributors, observations, activeDates }),
      statedRecurrence: Object.fromEntries(tally(activities.map(({ recurrence }) => recurrence)).map(({ value, count }) => [value, count])),
      systems: uniqueSorted(activities.flatMap(({ system }) => system === undefined ? [] : [system])),
      taskCategories: uniqueSorted(activities.flatMap(({ taskCategory }) => taskCategory === undefined ? [] : [taskCategory])),
      estimatedHours: roundHours(activities.reduce((sum, activity) => sum + durationHours(activity), 0)),
      unsizedObservations: activities.filter(({ durationBucket }) => durationBucket === undefined).length,
      frictionSignals: friction,
      energySignals: energy,
      automationHypotheses,
      ...(descriptor.entry?.quickWin === undefined ? {} : { quickWin: descriptor.entry.quickWin }),
      evidenceRefs: evidenceRefs(activities),
    };
    return routine;
  }).sort((left, right) => right.estimatedHours - left.estimatedHours || right.observations - left.observations || JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)));
}

function tallyLabels(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, { value: string; count: number }>();
  for (const value of values) {
    const key = routineKey(value);
    const existing = counts.get(key);
    counts.set(key, existing === undefined ? { value, count: 1 } : { value: existing.value, count: existing.count + 1 });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || routineKey(left.value).localeCompare(routineKey(right.value)));
}

function tallySignals<T extends string>(activities: ReportActivity[], facet: (activity: ReportActivity) => T | undefined, allowed: Set<T>): InternalRoutineSignal {
  const values = activities.map(facet).filter((value): value is T => value !== undefined && allowed.has(value));
  const byValue = Object.fromEntries(tally(values).map(({ value, count }) => [value, count]));
  return { count: values.length, byValue };
}

function observationCoverage(activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>): InternalCompanyEvidenceReport["coverage"]["unattributedObservations"] {
  return {
    count: activities.length,
    estimatedHours: roundHours(activities.reduce((sum, activity) => sum + durationHours(activity), 0)),
    unsized: activities.filter((activity) => activity.durationBucket === undefined).length,
  };
}

function buildTimeBudget(activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>): InternalTimeBudgetEntry[] {
  const groups = groupBy(activities, (activity) => activity.taskCategory ?? "__uncategorized__");
  const entries = [...groups.entries()].map(([key, observations]) => ({
    ...(key === "__uncategorized__" ? {} : { taskCategory: key as TaskCategory }),
    estimatedHours: roundHours(observations.reduce((sum, activity) => sum + durationHours(activity), 0)),
    share: 0,
    contributors: new Set(observations.map((activity) => activity.subjectKey)).size,
    observations: observations.length,
    unsizedObservations: observations.filter((activity) => activity.durationBucket === undefined).length,
  }));
  const totalHours = entries.reduce((sum, entry) => sum + entry.estimatedHours, 0);
  let assignedShare = 0;
  entries.sort((left, right) => right.estimatedHours - left.estimatedHours || timeBudgetKey(left).localeCompare(timeBudgetKey(right)));
  entries.forEach((entry, index) => {
    if (totalHours === 0) entry.share = 0;
    else if (index === entries.length - 1) entry.share = roundShare(1 - assignedShare);
    else {
      entry.share = roundShare(entry.estimatedHours / totalHours);
      assignedShare += entry.share;
    }
  });
  if (entries.length > 0 && totalHours > 0) entries.at(-1)!.share = roundShare(1 - entries.slice(0, -1).reduce((sum, entry) => sum + entry.share, 0));
  return entries;
}

function timeBudgetKey(entry: InternalTimeBudgetEntry): string {
  return entry.taskCategory ?? "__uncategorized__";
}

function durationHours(activity: Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">): number {
  return activity.durationBucket === undefined ? 0 : durationBucketHours[activity.durationBucket];
}

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundShare(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildBuckets(
  scope: InternalEvidenceBucket["scope"],
  activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>,
): InternalEvidenceBucket[] {
  const processGroups = groupBy(activities, (activity) => JSON.stringify({
    ...(activity.taskCategory ? { taskCategory: activity.taskCategory } : {}),
    ...(activity.routinePattern ? { routinePattern: activity.routinePattern } : {}),
  }));
  return [...processGroups.entries()].map(([key, observations]) => {
    const process = JSON.parse(key) as CompanyReportProcessKey;
    const contributors = new Set(observations.map((activity) => activity.subjectKey)).size;
    const activeDates = new Set(observations.map((activity) => activity.activityDate)).size;
    return {
      bucketId: bucketId(scope, process),
      scope,
      process,
      systems: uniqueSorted(observations.flatMap((activity) => activity.system ? [activity.system] : [])),
      durationBuckets: uniqueSorted(observations.flatMap((activity) => activity.durationBucket ? [activity.durationBucket] : [])),
      contributors,
      observations: observations.length,
      activeDates,
      confidence: confidenceForEvidence({ contributors, observations: observations.length, activeDates }),
      supportingEvidence: {
        automationHypotheses: buildSupportingFacets(observations, (activity) => activity.automationCandidate),
        humanImpactSignals: buildSupportingFacets(observations, (activity) => activity.energyStressMarker),
      },
      evidenceRefs: evidenceRefs(observations),
    };
  }).sort((left, right) => left.bucketId.localeCompare(right.bucketId));
}

function buildSupportingFacets<T extends string>(
  activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>,
  facet: (activity: Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">) => T | undefined,
): Array<InternalSupportingFacet<T>> {
  const withFacet = activities.filter((activity) => facet(activity) !== undefined);
  return [...groupBy(withFacet, (activity) => facet(activity)!).entries()]
    .map(([value, observations]) => {
      const contributors = new Set(observations.map((activity) => activity.subjectKey)).size;
      const activeDates = new Set(observations.map((activity) => activity.activityDate)).size;
      return {
        value: value as T,
        contributors,
        observations: observations.length,
        activeDates,
        confidence: confidenceForEvidence({ contributors, observations: observations.length, activeDates }),
        evidenceRefs: evidenceRefs(observations),
      };
    })
    .sort((left, right) => left.value.localeCompare(right.value));
}

function buildClientReport(internal: InternalCompanyEvidenceReport): ClientCompanyReport {
  const coverage = internal.coverage;
  const assessment = coverage.observations === 0
    ? "insufficient"
    : coverage.contributors >= 3 && coverage.activeDates >= 3 ? "usable" : "usable_with_limits";
  const limitations = [
    ...(coverage.contributors < 2 ? ["Наблюдения внесены одним contributor; межсубъектная повторяемость не проверена"] : []),
    ...(coverage.activeDates < 3 ? ["Наблюдения покрывают меньше трёх рабочих дат"] : []),
  ];
  const namedRoutines = internal.routines.filter((routine) =>
    routine.name !== undefined
    && routine.observations >= COMPANY_REPORT_CONFIDENCE_POLICY.clientMinimumObservations,
  );
  const topRoutines = namedRoutines.slice(0, 10).map((routine) => toClientRoutine(routine, internal));
  const frictionRoutines = namedRoutines
    .filter((routine) => routine.frictionSignals.count + routine.energySignals.count > 0)
    .sort((left, right) => right.frictionSignals.count + right.energySignals.count - (left.frictionSignals.count + left.energySignals.count) || right.estimatedHours - left.estimatedHours)
    .slice(0, 5)
    .map((routine) => toClientFrictionRoutine(routine, internal));
  const firstSteps = uniqueBy(
    [...topRoutines, ...frictionRoutines]
      .flatMap((routine) => routine.quickWin === undefined ? [] : [{ routine: routine.name, firstStep: routine.quickWin.firstStep, effort: routine.quickWin.effort, whoCanDo: routine.quickWin.whoCanDo }])
      .sort((left, right) => effortRank(left.effort) - effortRank(right.effort) || left.routine.localeCompare(right.routine)),
    (step) => step.routine,
  ).slice(0, 3);
  const deepDive = namedRoutines
    .filter((routine) => routine.quickWin === undefined || routine.quickWin === "deep_dive")
    .slice(0, 10)
    .map((routine) => ({
      name: routine.name!,
      scope: routineScope(routine, internal),
      question: routineQuestion(routine),
      reason: routine.quickWin === "deep_dive" ? "Запись справочника требует углублённого обследования" : "Для этой рутины пока не назначено быстрое улучшение",
    }));
  const unsizedShare = coverage.observations === 0 ? 0 : Math.round((coverage.unsizedObservations / coverage.observations) * 100);
  const cannotConclude = [
    ...(coverage.unsizedObservations > 0 ? [`Точные часы: ${unsizedShare} % наблюдений без длительности; часы — порядок величины по самоотчётам`] : []),
    ...(internal.routines.some((routine) => routine.name !== undefined && routine.observations < COMPANY_REPORT_CONFIDENCE_POLICY.clientMinimumObservations)
      ? ["Рутины с менее чем тремя наблюдениями за цикл не показаны"]
      : []),
    "Эффект и prerequisites быстрых улучшений требуют обследования процесса (второй этап)",
    ...limitations.map((limitation) => `Ограничение покрытия: ${limitation}`),
  ];
  const roleLabels = internal.reference?.roleLabels ?? {};
  const coveredRoles = Object.entries(internal.roleContributors)
    .filter(([, count]) => count >= 2)
    .map(([roleId]) => roleLabels[roleId])
    .filter((role): role is string => role !== undefined)
    .sort();
  return {
    schemaVersion: "minutka-client-report.v2",
    title: "Карта рутин и быстрых улучшений",
    companyLabel: internal.reference?.companyLabel ?? internal.companyId,
    groupLabel: internal.reference?.groupLabel ?? internal.groupId,
    period: internal.period,
    coverage: {
      assessment,
      invitedParticipants: coverage.invitedParticipants,
      contributors: coverage.contributors,
      activeDates: coverage.activeDates,
      observations: coverage.observations,
      unsizedObservations: coverage.unsizedObservations,
      unattributedObservations: coverage.unattributedObservations.count,
      coveredRoles,
      limitations,
    },
    timeBudget: internal.timeBudget,
    topRoutines,
    frictionRoutines,
    firstSteps,
    deepDive,
    cannotConclude: uniqueBy(cannotConclude, (item) => item),
  };
}

function toClientRoutine(routine: InternalRoutine, internal: InternalCompanyEvidenceReport): ClientRoutine {
  const quickWin = routine.quickWin === undefined || routine.quickWin === "deep_dive" ? undefined : findQuickWin(routine.quickWin);
  return {
    name: routine.name!,
    scope: routineScope(routine, internal),
    evidenceSummary: routineEvidenceSummary(routine),
    systems: routine.systems.map(systemLabel),
    statedRecurrence: routine.statedRecurrence,
    confidence: routine.confidence,
    ...(quickWin === undefined ? { deepDive: true as const, question: routineQuestion(routine) } : { quickWin }),
  };
}

function toClientFrictionRoutine(routine: InternalRoutine, internal: InternalCompanyEvidenceReport): ClientFrictionRoutine {
  const quickWin = routine.quickWin === undefined || routine.quickWin === "deep_dive" ? undefined : findQuickWin(routine.quickWin);
  return {
    name: routine.name!,
    scope: routineScope(routine, internal),
    signals: { ...routine.frictionSignals.byValue, ...routine.energySignals.byValue },
    evidenceSummary: routineEvidenceSummary(routine),
    confidence: routine.confidence,
    ...(quickWin === undefined ? { deepDive: true as const } : { quickWin }),
  };
}

function routineEvidenceSummary(routine: InternalRoutine): ClientRoutineEvidenceSummary {
  return { contributors: routine.contributors, observations: routine.observations, activeDates: routine.activeDates, estimatedHours: routine.estimatedHours, unsizedObservations: routine.unsizedObservations };
}

function routineScope(routine: InternalRoutine, internal: InternalCompanyEvidenceReport): string {
  if (routine.contributors >= 2 && routine.key.roleId && (internal.roleContributors[routine.key.roleId] ?? 0) >= 2) return internal.reference?.roleLabels[routine.key.roleId] ?? "группа";
  return "группа";
}

function routineQuestion(routine: InternalRoutine): string {
  return `Как устроена рутина «${routine.name}» и какую её часть можно упростить без потери контроля?`;
}

function effortRank(effort: "hours" | "days" | "weeks"): number {
  return ({ hours: 0, days: 1, weeks: 2 } as const)[effort];
}

function periodForActivities(activities: ReportActivity[], generatedAt: string): { start: string; end: string } {
  const dates = activities.map(({ activityDate }) => activityDate).sort();
  return { start: dates[0] ?? generatedAt.slice(0, 10), end: dates.at(-1) ?? generatedAt.slice(0, 10) };
}

function systemLabel(value: ActivitySystem): string {
  return ({ bitrix24: "Bitrix24", one_c: "1С", spreadsheets: "Электронные таблицы", email: "Почта", messengers: "Мессенджеры", crm: "CRM", task_tracker: "Таск-трекер", telephony: "Телефония", tender_platform: "Тендерная площадка", logistics_system: "Логистическая система", learning_platform: "Платформа обучения", paper_or_verbal: "Бумага или устно", other: "Другая система" } as const)[value];
}
function evidenceRefs(activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>): CompanyReportEvidenceRef[] {
  return activities
    .map((activity) => ({ kind: "activity" as const, id: activity.activityId, subjectKey: activity.subjectKey }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
function bucketId(scope: InternalEvidenceBucket["scope"], process: CompanyReportProcessKey): string {
  const scopeKey = scope.kind === "overall_group" ? "overall" : `role-${scope.roleId}`;
  const processKey = [
    process.taskCategory ?? "uncategorized",
    process.routinePattern ?? "no-observed-friction",
  ].join("-");
  return `${scopeKey}-${processKey}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}
function assertExactScope(companyId: string, groupId: string, snapshot: CompanyReportSnapshot): void {
  const subjectKeys = new Set<string>();
  for (const subject of snapshot.subjects) {
    if (!subject.subjectKey || subjectKeys.has(subject.subjectKey)) throw new Error("company report store returned an invalid subject binding");
    subjectKeys.add(subject.subjectKey);
  }
  if (snapshot.activities.some((activity) => activity.companyId !== companyId || activity.groupId !== groupId || !subjectKeys.has(activity.subjectKey))) {
    throw new Error("company report store returned a cross-scope canonical activity");
  }
}
function groupBy<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) grouped.set(key(record), [...(grouped.get(key(record)) ?? []), record]);
  return grouped;
}
function uniqueSorted<T extends string>(values: T[]): T[] { return [...new Set(values)].sort(); }
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] { return [...new Map(values.map((value) => [key(value), value])).values()]; }
