import type { ActivityObstacle, PersonalActivityRecord } from "./activity-collection.js";
import type { ActivityDurationBucket, ActivitySystem, TaskCategory } from "../domain/insights.js";

export const COMPANY_REPORT_CONFIDENCE_POLICY = {
  signalSubjects: 2,
  confirmedSubjects: 3,
  confirmedObservations: 5,
  confirmedDates: 3,
} as const;

export type CompanyReportConfidence = "hypothesis" | "signal" | "confirmed";
export type CompanyReportEvidenceRef = { kind: "activity"; id: string; subjectKey: string };
export type CompanyReportProcessKey = { taskCategory?: TaskCategory; obstacle?: ActivityObstacle };

export type CompanyReportSnapshot = {
  invitedParticipants: number;
  subjects: Array<{ subjectKey: string; roleId?: string }>;
  activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>;
};

export type CompanyReportStore = {
  loadGroupSnapshot(input: { companyId: string; groupId: string }): Promise<CompanyReportSnapshot>;
};

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
  evidenceRefs: CompanyReportEvidenceRef[];
};

export type InternalCompanyEvidenceReport = {
  schemaVersion: "minutka-internal-report/v1";
  generatedAt: string;
  companyId: string;
  groupId: string;
  coverage: {
    invitedParticipants: number;
    subjects: number;
    contributors: number;
    observations: number;
    activeDates: number;
  };
  buckets: InternalEvidenceBucket[];
};

export type ClientReportRecommendation = {
  recommendationId: string;
  process: string;
  scope: string;
  systems: string[];
  evidenceSummary: {
    contributors: number;
    observations: number;
    activeDates: number;
    summary: string;
    limitations: string[];
  };
  confidence: CompanyReportConfidence;
  automationOption: string;
  humanInTheLoop: string;
  expectedEffect: string;
  prerequisites: string[];
  risks: string[];
};

export type ClientCompanyReport = {
  schemaVersion: "minutka-client-report.v1";
  title: string;
  companyLabel: string;
  groupLabel: string;
  coverage: {
    assessment: "insufficient" | "usable_with_limits" | "usable";
    invitedParticipants: number;
    contributors: number;
    activeDates: number;
    observations: number;
    limitations: string[];
  };
  recommendations: ClientReportRecommendation[];
  insufficientEvidence: Array<{
    scope: string;
    question: string;
    reason: string;
    allowedConclusion: string;
  }>;
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

  async exportGroup(input: { companyId: string; groupId: string }): Promise<CompanyReportResult> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");

    const snapshot = await this.store.loadGroupSnapshot({ companyId, groupId });
    assertExactScope(companyId, groupId, snapshot);
    const subjectKeys = new Set(snapshot.subjects.map((subject) => subject.subjectKey));
    const activities = snapshot.activities.filter((activity) => subjectKeys.has(activity.subjectKey));
    const internal = buildInternalReport(companyId, groupId, snapshot.invitedParticipants, snapshot.subjects.length, activities, this.now());
    return { internal, client: buildClientReport(internal) };
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
): InternalCompanyEvidenceReport {
  const contributors = new Set(activities.map((activity) => activity.subjectKey)).size;
  const activeDates = new Set(activities.map((activity) => activity.activityDate)).size;
  return {
    schemaVersion: "minutka-internal-report/v1",
    generatedAt,
    companyId,
    groupId,
    coverage: { invitedParticipants, subjects: subjectCount, contributors, observations: activities.length, activeDates },
    buckets: [
      ...buildBuckets({ kind: "overall_group" }, activities),
      ...[...groupBy(activities, (activity) => activity.roleId).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([roleId, roleActivities]) => buildBuckets({ kind: "role", roleId }, roleActivities)),
    ],
  };
}

function buildBuckets(
  scope: InternalEvidenceBucket["scope"],
  activities: Array<Omit<PersonalActivityRecord, "employeeId" | "sourceMessageId">>,
): InternalEvidenceBucket[] {
  const processGroups = groupBy(activities, (activity) => JSON.stringify({
    ...(activity.taskCategory ? { taskCategory: activity.taskCategory } : {}),
    ...(activity.obstacle ? { obstacle: activity.obstacle } : {}),
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
      evidenceRefs: observations
        .map((activity) => ({ kind: "activity" as const, id: activity.activityId, subjectKey: activity.subjectKey }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }).sort((left, right) => left.bucketId.localeCompare(right.bucketId));
}

function buildClientReport(internal: InternalCompanyEvidenceReport): ClientCompanyReport {
  const coverage = internal.coverage;
  const assessment = coverage.observations === 0
    ? "insufficient"
    : coverage.contributors >= 3 && coverage.activeDates >= 3 ? "usable" : "usable_with_limits";
  const limitations = [
    ...(coverage.contributors < 2 ? ["Evidence внесено одним contributor; межсубъектная повторяемость не проверена"] : []),
    ...(coverage.activeDates < 3 ? ["Наблюдения покрывают меньше трёх рабочих дат"] : []),
  ];
  const overallBuckets = internal.buckets.filter((bucket) => bucket.scope.kind === "overall_group");
  const recommendations = overallBuckets.filter((bucket) => isAutomationOpportunity(bucket.process)).map(toClientRecommendation);
  const roleHypotheses = internal.buckets
    .filter((bucket) => bucket.scope.kind === "role" && bucket.confidence === "hypothesis" && isAutomationOpportunity(bucket.process))
    .map((bucket) => ({
      scope: "Редкая рабочая функция",
      question: processLabel(bucket.process),
      reason: evidenceSentence(bucket),
      allowedConclusion: "Гипотеза о процессе для интервью; не оценка сотрудника и не подтверждённый вывод",
    }));
  return {
    schemaVersion: "minutka-client-report.v1",
    title: "Карта возможностей автоматизации",
    companyLabel: internal.companyId,
    groupLabel: internal.groupId,
    coverage: {
      assessment,
      invitedParticipants: coverage.invitedParticipants,
      contributors: coverage.contributors,
      activeDates: coverage.activeDates,
      observations: coverage.observations,
      limitations,
    },
    recommendations,
    insufficientEvidence: uniqueBy(roleHypotheses, (item) => `${item.scope}:${item.question}`),
  };
}

function toClientRecommendation(bucket: InternalEvidenceBucket): ClientReportRecommendation {
  const process = processLabel(bucket.process);
  return {
    recommendationId: bucket.bucketId,
    process,
    scope: "Вся группа",
    systems: bucket.systems.map(systemLabel),
    evidenceSummary: {
      contributors: bucket.contributors,
      observations: bucket.observations,
      activeDates: bucket.activeDates,
      summary: evidenceSentence(bucket),
      limitations: bucket.confidence === "hypothesis" ? ["Требуется интервью или дополнительное наблюдение"] : [],
    },
    confidence: bucket.confidence,
    automationOption: automationOption(bucket.process),
    humanInTheLoop: "Владелец процесса проверяет исключения и подтверждает спорные результаты",
    expectedEffect: expectedEffect(bucket.process),
    prerequisites: ["владелец процесса", "неперсональный пример текущего процесса", "baseline времени и ошибок"],
    risks: ["неполное покрытие исключений", "автоматизация нестабильного процесса"],
  };
}

function isAutomationOpportunity(process: CompanyReportProcessKey): boolean {
  return process.obstacle?.kind === "automation_candidate"
    || (process.obstacle?.kind === "routine_pattern" && ["manual_reporting", "coordination_overhead", "meeting_overload", "context_switching"].includes(process.obstacle.value));
}

function processLabel(process: CompanyReportProcessKey): string {
  const task = process.taskCategory ? taskCategoryLabel(process.taskCategory) : "Рабочий процесс";
  if (!process.obstacle) return task;
  return `${task}: ${obstacleLabel(process.obstacle)}`;
}

function taskCategoryLabel(value: TaskCategory): string {
  return ({ planning: "Планирование", reporting: "Подготовка отчётности", meetings: "Встречи", coordination: "Координация", communication: "Коммуникация", admin: "Административная работа", focus_work: "Фокусная работа", unknown: "Рабочий процесс" } as const)[value];
}
function obstacleLabel(obstacle: ActivityObstacle): string {
  const labels: Record<string, string> = {
    manual_reporting: "ручная отчётность", coordination_overhead: "избыточная координация", meeting_overload: "перегруз встречами", context_switching: "переключение контекста", waiting_for_input: "ожидание входных данных", unclear_priority: "неясный приоритет", report_generation: "генерация отчётов", meeting_reduction: "сокращение встреч", async_status_update: "асинхронные статусы", task_routing: "маршрутизация задач", template_or_checklist: "шаблон или чек-лист", data_entry_reduction: "сокращение ручного ввода", overload: "перегруз", fatigue: "усталость", frustration: "фрустрация", focus_loss: "потеря фокуса", blocked_progress: "блокировка прогресса", neutral: "нейтральный сигнал", other: "прочее",
  };
  return labels[obstacle.value] ?? "рабочее препятствие";
}
function systemLabel(value: ActivitySystem): string {
  return ({ bitrix24: "Bitrix24", one_c: "1С", spreadsheets: "Электронные таблицы", email: "Почта", messengers: "Мессенджеры", crm: "CRM", task_tracker: "Таск-трекер", paper_or_verbal: "Бумага или устно", other: "Другая система" } as const)[value];
}
function automationOption(process: CompanyReportProcessKey): string {
  if (process.obstacle?.kind === "automation_candidate") return `Проверить вариант «${obstacleLabel(process.obstacle)}» на ограниченном участке`;
  return "Стандартизировать шаги процесса и автоматизировать повторяемую часть с ручной очередью исключений";
}
function expectedEffect(process: CompanyReportProcessKey): string {
  return process.obstacle?.value === "meeting_overload" ? "Сокращение синхронных согласований" : "Сокращение повторного ручного труда и числа ошибок";
}
function evidenceSentence(bucket: InternalEvidenceBucket): string {
  return `${bucket.contributors} contributor(s), ${bucket.observations} observation(s), ${bucket.activeDates} active date(s)`;
}
function bucketId(scope: InternalEvidenceBucket["scope"], process: CompanyReportProcessKey): string {
  const scopeKey = scope.kind === "overall_group" ? "overall" : `role-${scope.roleId}`;
  const processKey = [process.taskCategory ?? "uncategorized", process.obstacle?.kind ?? "no-obstacle", process.obstacle?.value ?? "none"].join("-");
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
