import { z } from "zod";
import type { ResearchCorpusExport, ResearchCorpusScope } from "./research-corpus-export.js";
import { recommendationArtifactSchema, type RecommendationArtifact, type RecommendationEpisode } from "./retrospective-recommendations.js";
import { sanitizeResearchText } from "./research-trace-store.js";

const text = z.string().trim().min(1);
const dated = { timestamp: z.iso.datetime(), refs: z.array(text).min(1) };
/** Receipts for measurements not present in canonical turns. Absence is unknown, never zero. */
export const retrospectiveMeasurementsSchema = z.strictObject({
  scope: z.strictObject({ companyId: text, groupId: text }),
  touches: z.array(z.strictObject({ ...dated, touchId: text, subjectKey: text, process: text,
    methodVersion: text, eligible: z.boolean(), delivery: z.enum(["delivered", "failed", "unknown"]),
    replyMessageIds: z.array(text), invitation: z.boolean(), acceptanceMessageId: text.optional() })),
  observations: z.array(z.strictObject({ ...dated, subjectKey: text, episodeId: text.optional(),
    kind: z.enum(["attempted", "observed_result", "skip", "factual_error", "duplicate_time", "short_answer_resolved", "short_answer_unresolved", "complaint", "disabled", "employee_minutes", "operator_minutes"]),
    minutes: z.number().nonnegative().optional(), reason: text.optional() })),
  changes: z.array(z.strictObject({ ...dated, oldVersion: text, newVersion: text, reason: text })),
  omissions: z.array(text),
});
export type RetrospectiveMeasurements = z.infer<typeof retrospectiveMeasurementsSchema>;
export type RetrospectiveEvaluationRequest = ResearchCorpusScope & { start: string; end: string };
export type CandidateRubric = {
  candidateId: string;
  operation: "supported" | "disputed" | "unknown";
  claims: "supported" | "disputed" | "unknown";
  firstTest: "supported" | "disputed" | "unknown";
  humanControl: "supported" | "disputed" | "unknown";
  unknowns: "supported" | "disputed" | "unknown";
  refs: string[]; disputedCases: string[];
  comparison?: { initialFirstTest: string; fullFirstTest: string; newEvidenceRefs: string[]; explanation: string };
};
export type RetrospectiveRubricGenerator = {
  version: string;
  evaluate(input: { episodes: RecommendationEpisode[]; artifacts: RecommendationArtifact[]; corpus: ResearchCorpusExport }): Promise<CandidateRubric[]>;
};
export type RetrospectiveEvaluationRead = {
  /** Implementations must use typed scoped research reads; private offline exports are also supported. */
  read(scope: ResearchCorpusScope): Promise<{ corpus: ResearchCorpusExport; artifacts: RecommendationArtifact[]; measurements?: RetrospectiveMeasurements }>;
};
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const unique = (items: string[]) => [...new Set(items)].sort();

export class RetrospectiveEvaluationService {
  constructor(private readonly source: RetrospectiveEvaluationRead, private readonly generator?: RetrospectiveRubricGenerator,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async evaluate(request: RetrospectiveEvaluationRequest) {
    if (!request.companyId.trim() || !request.groupId.trim() || !Number.isFinite(Date.parse(request.start))
      || !Number.isFinite(Date.parse(request.end)) || Date.parse(request.start) > Date.parse(request.end)) throw new Error("invalid_evaluation_scope_or_period");
    const scope = { companyId: request.companyId, groupId: request.groupId };
    const input = await this.source.read(scope);
    const sameScope = (record: ResearchCorpusScope) => record.companyId === scope.companyId && record.groupId === scope.groupId;
    if (!sameScope(input.corpus.scope)) throw new Error("cross_scope_corpus");
    const within = (date: string) => Date.parse(date) >= Date.parse(request.start) && Date.parse(date) <= Date.parse(request.end);
    const subjects = new Set(input.corpus.subjects.map((subject) => subject.subjectKey));
    if (input.corpus.messages.some((message) => !subjects.has(message.subjectKey))
      || [...input.corpus.activities, ...input.corpus.traces, ...input.corpus.evaluationCases].some((record) => !sameScope(record) || !subjects.has(record.subjectKey))) throw new Error("cross_scope_evidence");
    const messages = input.corpus.messages.filter((message) => within(message.timestamp));
    const employee = messages.filter((message) => message.metadata?.origin === "employee");
    const employeeIds = new Map(employee.map((message) => [message.messageId, message.subjectKey]));
    const allMessageIds = new Set(input.corpus.messages.map((message) => message.messageId));
    const events = [...new Map(input.corpus.messages.flatMap((message) => [
      ...(message.metadata?.retrospectiveEvents ?? []), ...(message.metadata?.deliveryEvents ?? []),
    ]).map((event) => [event.eventId, event])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.ordinal - b.ordinal);
    if (events.some((event) => !sameScope(event) || !subjects.has(event.subjectKey) || !allMessageIds.has(event.sourceMessageId))) throw new Error("cross_scope_event");
    const episodeMap = new Map<string, RecommendationEpisode>();
    const key = (episode: { subjectKey: string; threadId: string; episodeId: string }) => JSON.stringify([episode.subjectKey, episode.threadId, episode.episodeId]);
    for (const event of events.filter((event) => Date.parse(event.timestamp) <= Date.parse(request.end))) {
      const action = event.action;
      if (action.type === "episode_selected" || action.type === "episode_updated") {
        if (!sameScope(action.episode) || action.episode.subjectKey !== event.subjectKey || action.episode.threadId !== event.threadId || action.episode.episodeId !== event.episodeId) throw new Error("cross_scope_episode");
        const { employeeId: _identity, ...episode } = structuredClone(action.episode);
        episodeMap.set(key(event), episode);
      } else if (action.type === "episode_status_changed") {
        const episode = episodeMap.get(key(event));
        if (episode) episode.status = action.status;
      }
    }
    // One case per episode, regardless of the number of follow-up turns.
    const episodes = [...episodeMap.values()].filter((episode) => events.some((event) => key(event) === key(episode) && within(event.timestamp)));
    const artifacts = input.artifacts.map((artifact) => recommendationArtifactSchema.parse(artifact)).filter((artifact) => {
      if (!sameScope(artifact.scope) || artifact.contributors.some((subject) => !subjects.has(subject))) throw new Error("cross_scope_artifact");
      return within(artifact.createdAt);
    });
    const measurements = input.measurements ? retrospectiveMeasurementsSchema.parse(input.measurements) : undefined;
    if (measurements && (!sameScope(measurements.scope) || [...measurements.touches, ...measurements.observations].some((row) => !subjects.has(row.subjectKey)))) throw new Error("cross_scope_measurements");
    const touches = measurements?.touches.filter((touch) => within(touch.timestamp)) ?? [];
    if (new Set(touches.map((touch) => touch.touchId)).size !== touches.length) throw new Error("duplicate_touch_receipt");
    const observations = measurements?.observations.filter((row) => within(row.timestamp)) ?? [];
    const week = (timestamp: string) => Math.floor((Date.parse(timestamp) - Date.parse(request.start)) / (7 * 86400000)) + 1;
    const buckets = unique(touches.map((touch) => JSON.stringify([touch.process, week(touch.timestamp), touch.methodVersion]))).map((bucket) => {
      const [process, weekNumber, methodVersion] = JSON.parse(bucket) as [string, number, string];
      const rows = touches.filter((touch) => touch.process === process && week(touch.timestamp) === weekNumber && touch.methodVersion === methodVersion);
      const eligible = rows.filter((touch) => touch.eligible);
      const delivered = eligible.filter((touch) => touch.delivery === "delivered");
      const invitations = delivered.filter((touch) => touch.invitation);
      return { process, week: weekNumber, methodVersion, delivery: ratio(delivered.length, eligible.length),
        response: ratio(delivered.filter((touch) => touch.replyMessageIds.some((id) => employeeIds.get(id) === touch.subjectKey)).length, delivered.length),
        invitationAcceptance: ratio(invitations.filter((touch) => touch.acceptanceMessageId && employeeIds.get(touch.acceptanceMessageId) === touch.subjectKey).length, invitations.length),
        failed: eligible.filter((touch) => touch.delivery === "failed").length, unknownDelivery: eligible.filter((touch) => touch.delivery === "unknown").length,
        refs: unique(rows.flatMap((row) => row.refs)) };
    });
    const stageNames = ["actions", "value", "future", "indicators"] as const;
    const quality = episodes.map((episode) => ({ subjectKey: episode.subjectKey, episodeId: episode.episodeId,
      methodVersion: episode.methodVersion, revision: episode.revision, status: episode.status,
      stages: Object.fromEntries(stageNames.map((stage) => [stage, episode.statements[stage].filter((statement) => statement.kind !== "agent_hypothesis" && statement.sourceRefs.length).map((statement) => ({ statementId: statement.statementId, refs: statement.sourceRefs }))])),
      selectedStep: episode.selectedStep ? { statementId: episode.selectedStep.statementId, refs: episode.selectedStep.sourceRefs } : null,
      deliveredQuestions: unique(events.filter((event) => key(event) === key(episode) && within(event.timestamp) && event.action.type === "response_delivery" && event.action.status === "delivered" && event.action.questionId).map((event) => event.action.type === "response_delivery" ? event.action.questionId! : "")),
    }));
    const countCases = (kind: "attempted" | "observed_result") => unique(observations.filter((row) => row.kind === kind && row.episodeId && episodes.some((episode) => episode.subjectKey === row.subjectKey && episode.episodeId === row.episodeId)).map((row) => JSON.stringify([row.subjectKey, row.episodeId]))).length;
    const traces = input.corpus.traces.filter((trace) => within(trace.startedAt));
    const rubrics = this.generator ? await this.generator.evaluate({ episodes, artifacts, corpus: { ...input.corpus, messages, traces } }) : [];
    const validRefs = new Set([...allMessageIds, ...events.map((event) => event.eventId), ...episodes.flatMap((episode) => Object.values(episode.statements).flatMap((statements) => statements.map((statement) => statement.statementId)))]);
    const rubricSchema = z.strictObject({ candidateId: text, operation: z.enum(["supported", "disputed", "unknown"]),
      claims: z.enum(["supported", "disputed", "unknown"]), firstTest: z.enum(["supported", "disputed", "unknown"]),
      humanControl: z.enum(["supported", "disputed", "unknown"]), unknowns: z.enum(["supported", "disputed", "unknown"]),
      refs: z.array(text).min(1), disputedCases: z.array(text), comparison: z.strictObject({ initialFirstTest: text,
        fullFirstTest: text, newEvidenceRefs: z.array(text).min(1), explanation: text }).optional() });
    for (const rubric of rubrics) {
      rubricSchema.parse(rubric);
      if (!artifacts.some((artifact) => artifact.candidates.some((candidate) => candidate.candidateId === rubric.candidateId))
        || [...rubric.refs, ...(rubric.comparison?.newEvidenceRefs ?? [])].some((ref) => !validRefs.has(ref))) throw new Error("unsupported_rubric_evidence");
    }
    const candidates = artifacts.flatMap((artifact) => artifact.candidates.map((candidate) => ({ artifactId: artifact.artifactId, artifactVersion: artifact.version,
      candidateId: candidate.candidateId, status: candidate.status, review: candidate.review ?? null,
      structuralRubric: { operation: !!candidate.operation.text, claimsHaveRefs: [candidate.operation, candidate.opportunity, ...candidate.facts, ...Object.values(candidate.known).filter((claim) => claim !== null)].every((claim) => claim.refs.length > 0),
        firstTest: !!candidate.firstTest, humanControl: !!candidate.humanControl, unknowns: candidate.unknowns },
      agentEvaluation: rubrics.find((rubric) => rubric.candidateId === candidate.candidateId) ?? null,
      operatorReviewRequired: true })));
    const feedback = employee.filter((message) => message.feedback.length);
    return {
      schemaVersion: "retrospective-evaluation/v1" as const, visibility: "private_research" as const, evaluatedAt: this.now(), scope,
      period: { start: request.start, end: request.end }, conclusion: "Diagnostic evidence only; no causal uplift or proven effect. Sparse feedback limits conclusions.",
      participation: { buckets, activeEmployees: unique(employee.map((message) => message.subjectKey)).length,
        participantDays: unique(employee.map((message) => `${message.subjectKey}:${message.timestamp.slice(0, 10)}`)).length,
        dayBasis: "UTC message dates; not employee time expenditure", employeeMessages: employee.length,
        scheduledMessages: messages.filter((message) => message.metadata?.origin === "scheduled").length,
        unknownOrigin: messages.filter((message) => !message.metadata?.origin || message.metadata.origin === "unknown").length,
        feedbackRespondents: ratio(unique(feedback.map((message) => message.subjectKey)).length, unique(employee.map((message) => message.subjectKey)).length),
        feedbackRefs: feedback.map((message) => message.messageId) },
      episodes: { count: episodes.length, started: unique(events.filter((event) => within(event.timestamp) && event.action.type === "episode_selected").map(key)).length,
        completed: episodes.filter((episode) => episode.status === "completed").length, paused: episodes.filter((episode) => episode.status === "paused").length,
        declined: episodes.filter((episode) => episode.status === "declined").length, quality,
        stages: Object.fromEntries(stageNames.map((stage) => [stage, ratio(quality.filter((row) => (row.stages[stage] as unknown[]).length).length, episodes.length)])),
        selected: episodes.filter((episode) => episode.selectedStep?.sourceRefs.length).length, attempted: countCases("attempted"), observedResult: countCases("observed_result") },
      measurements: observations, costs: { usage: traces.map((trace) => ({ traceId: trace.traceId, usage: trace.usage ?? null, latencyMs: trace.latencyMs, status: trace.status })),
        failures: traces.filter((trace) => trace.status === "failed").length,
        employeeMinutes: observations.filter((row) => row.kind === "employee_minutes"), operatorMinutes: observations.filter((row) => row.kind === "operator_minutes") },
      extractionEvaluations: input.corpus.evaluationCases.filter((record) => within(record.createdAt)).map((record) => ({ caseId: record.caseId, messageId: record.messageId, labels: record.labels })),
      candidates, versions: { corpus: input.corpus.versions, methods: unique(episodes.map((episode) => episode.methodVersion)),
        artifacts: artifacts.map((artifact) => ({ artifactId: artifact.artifactId, version: artifact.version, previousArtifactId: artifact.previousArtifactId, versions: artifact.versions })), evaluator: this.generator?.version ?? null },
      changes: measurements?.changes.filter((change) => within(change.timestamp)) ?? [],
      omissions: [...(measurements?.omissions ?? []), ...(!measurements ? ["Eligibility, invitation, attempts, skips, employee self-report and operator time receipts unavailable; not inferred from wall-clock or message counts."] : []),
        ...(!this.generator ? ["Agent semantic rubric and paired initial/full comparison unavailable; structural checks are not quality judgments."] : [])],
    };
  }
}
export type RetrospectiveEvaluation = Awaited<ReturnType<RetrospectiveEvaluationService["evaluate"]>>;
export function renderRetrospectiveEvaluation(evaluation: RetrospectiveEvaluation): string {
  // Sanitize values before encoding so credential patterns cannot corrupt JSON syntax.
  return JSON.stringify(evaluation, (_key, value: unknown) => typeof value === "string" ? sanitizeResearchText(value) : value, 2) + "\n";
}
