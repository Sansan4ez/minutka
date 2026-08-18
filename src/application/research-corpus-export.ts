import type { PersonalActivityRecord } from "./activity-collection.js";
import type { AuditEventStore } from "./audit-event-store.js";
import type { EvaluationCaseRecord, EvaluationCaseStore } from "./research-evaluation.js";
import type { ResearchSubject } from "./research-identity-projection.js";
import { sanitizeResearchText, sanitizeResearchTrace, type ResearchTraceRecord, type ResearchTraceStore } from "./research-trace-store.js";
import { randomIdGenerator, systemClock, type Clock } from "./runtime-primitives.js";
import type { FeedbackRating } from "../domain/feedback.js";

export const researchCorpusExportSchemaVersion = "research-corpus-export/v1" as const;

export type ResearchCorpusScope = { companyId: string; groupId: string };

export type ResearchCorpusMessage = {
  messageId: string;
  subjectKey: string;
  userText: string;
  agentResponse: string;
  timestamp: string;
  trace: { status: "present"; traceId: string; requestId: string } | { status: "missing" };
  feedback: Array<{ feedbackId: string; rating: FeedbackRating; createdAt: string; updatedAt: string }>;
};

export type ResearchCorpusExport = {
  schemaVersion: typeof researchCorpusExportSchemaVersion;
  exportedAt: string;
  scope: ResearchCorpusScope;
  subjects: Array<Pick<ResearchSubject, "subjectKey" | "roleId" | "evidenceRefs">>;
  messages: ResearchCorpusMessage[];
  activities: Array<Omit<PersonalActivityRecord, "employeeId">>;
  traces: ResearchTraceRecord[];
  evaluationCases: EvaluationCaseRecord[];
  versions: { prompts: string[]; processes: string[]; taxonomies: string[]; models: string[] };
  coverage: {
    subjects: number;
    messages: number;
    activities: number;
    traces: number;
    feedback: number;
    evaluationCases: number;
    messagesWithTrace: number;
    messagesMissingTrace: number;
  };
};

export type ResearchCorpusSource = {
  listSubjects(scope: ResearchCorpusScope): Promise<ResearchSubject[]>;
  listMessages(scope: ResearchCorpusScope): Promise<Array<{
    messageId: string;
    subjectKey: string;
    userText: string;
    agentResponse: string;
    timestamp: string;
  }>>;
  listActivities(scope: ResearchCorpusScope): Promise<Array<Omit<PersonalActivityRecord, "employeeId">>>;
  listFeedback(scope: ResearchCorpusScope): Promise<Array<{
    feedbackId: string;
    targetMessageId: string;
    rating: FeedbackRating;
    createdAt: string;
    updatedAt: string;
  }>>;
};

export type ResearchCorpusFormat = "json" | "jsonl" | "markdown";

export class ResearchCorpusExportService {
  constructor(
    private readonly source: ResearchCorpusSource,
    private readonly traces: Pick<ResearchTraceStore, "list">,
    private readonly evaluations: Pick<EvaluationCaseStore, "list">,
    private readonly audit?: AuditEventStore,
    private readonly clock: Clock = systemClock,
    private readonly auditId: () => string = randomIdGenerator.auditEventId,
  ) {}

  async export(input: ResearchCorpusScope & { format: ResearchCorpusFormat }): Promise<{ format: ResearchCorpusFormat; content: string; corpus: ResearchCorpusExport }> {
    const scope = normalizeScope(input);
    const exportedAt = this.clock.now();
    try {
      const [subjects, messages, activities, traces, feedback, evaluationCases] = await Promise.all([
        this.source.listSubjects(scope),
        this.source.listMessages(scope),
        this.source.listActivities(scope),
        this.traces.list(scope),
        this.source.listFeedback(scope),
        this.evaluations.list(scope),
      ]);
      assertExactScope(scope, subjects, messages, activities, traces, feedback, evaluationCases);
      const tracesByMessage = new Map(traces.map((trace) => [trace.messageId, trace]));
      const feedbackByMessage = groupBy(feedback, (record) => record.targetMessageId);
      const corpus: ResearchCorpusExport = {
        schemaVersion: researchCorpusExportSchemaVersion,
        exportedAt,
        scope,
        subjects: subjects.map(({ subjectKey, roleId, evidenceRefs }) => ({ subjectKey, ...(roleId ? { roleId } : {}), evidenceRefs })),
        messages: messages.map((message) => {
          const trace = tracesByMessage.get(message.messageId);
          return {
            ...message,
            userText: sanitizeResearchText(message.userText),
            agentResponse: sanitizeResearchText(message.agentResponse),
            trace: trace ? { status: "present", traceId: trace.traceId, requestId: trace.requestId } : { status: "missing" },
            feedback: (feedbackByMessage.get(message.messageId) ?? []).map(({ feedbackId, rating, createdAt, updatedAt }) => ({ feedbackId, rating, createdAt, updatedAt })),
          };
        }),
        activities,
        traces: traces.map(sanitizeResearchTrace),
        evaluationCases: evaluationCases.map((record) => ({
          ...record,
          labels: { ...record.labels, ...(record.labels.notes ? { notes: sanitizeResearchText(record.labels.notes) } : {}) },
        })),
        versions: {
          prompts: uniqueSorted(traces.map((trace) => trace.promptVersion)),
          processes: uniqueSorted(traces.map((trace) => trace.processVersion)),
          taxonomies: uniqueSorted(traces.map((trace) => trace.taxonomyVersion)),
          models: uniqueSorted(traces.map((trace) => trace.model)),
        },
        coverage: {
          subjects: subjects.length,
          messages: messages.length,
          activities: activities.length,
          traces: traces.length,
          feedback: feedback.length,
          evaluationCases: evaluationCases.length,
          messagesWithTrace: messages.filter((message) => tracesByMessage.has(message.messageId)).length,
          messagesMissingTrace: messages.filter((message) => !tracesByMessage.has(message.messageId)).length,
        },
      };
      await this.auditExport(scope, corpus.coverage, "succeeded", exportedAt);
      return { format: input.format, content: renderResearchCorpus(corpus, input.format), corpus };
    } catch (error) {
      await this.auditExport(scope, emptyCoverage(), "failed", exportedAt);
      throw error;
    }
  }

  private async auditExport(scope: ResearchCorpusScope, counts: ResearchCorpusExport["coverage"], outcome: "succeeded" | "failed", occurredAt: string): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.auditId(),
      requestId: `research_export:${scope.companyId}:${scope.groupId}:${occurredAt}`,
      type: "research_corpus_exported",
      occurredAt,
      metadata: { companyId: scope.companyId, groupId: scope.groupId, outcome, ...counts },
    });
  }
}

export function renderResearchCorpus(corpus: ResearchCorpusExport, format: ResearchCorpusFormat): string {
  if (format === "json") return `${JSON.stringify(corpus, null, 2)}\n`;
  if (format === "jsonl") {
    const header = { recordType: "manifest", schemaVersion: corpus.schemaVersion, exportedAt: corpus.exportedAt, scope: corpus.scope, versions: corpus.versions, coverage: corpus.coverage };
    return [
      header,
      ...corpus.subjects.map((record) => ({ recordType: "subject", ...record })),
      ...corpus.messages.map((record) => ({ recordType: "message", ...record })),
      ...corpus.activities.map((record) => ({ recordType: "activity", ...record })),
      ...corpus.traces.map((record) => ({ recordType: "trace", ...record })),
      ...corpus.evaluationCases.map((record) => ({ recordType: "evaluation_case", ...record })),
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  }
  return [
    "# Research corpus summary",
    "",
    `- Company: \`${corpus.scope.companyId}\``,
    `- Group: \`${corpus.scope.groupId}\``,
    `- Exported at: ${corpus.exportedAt}`,
    `- Subjects: ${corpus.coverage.subjects}`,
    `- Messages: ${corpus.coverage.messages}`,
    `- Activities: ${corpus.coverage.activities}`,
    `- Traces: ${corpus.coverage.traces}`,
    `- Feedback labels: ${corpus.coverage.feedback}`,
    `- Evaluation cases: ${corpus.coverage.evaluationCases}`,
    `- Messages with trace: ${corpus.coverage.messagesWithTrace}`,
    `- Messages missing trace: ${corpus.coverage.messagesMissingTrace}`,
    "",
    "## Versions",
    "",
    `- Prompt: ${corpus.versions.prompts.join(", ") || "none"}`,
    `- Process: ${corpus.versions.processes.join(", ") || "none"}`,
    `- Taxonomy: ${corpus.versions.taxonomies.join(", ") || "none"}`,
    `- Model: ${corpus.versions.models.join(", ") || "none"}`,
    "",
  ].join("\n");
}

function normalizeScope(scope: ResearchCorpusScope): ResearchCorpusScope {
  const companyId = scope.companyId.trim();
  const groupId = scope.groupId.trim();
  if (!companyId || !groupId) throw new Error("companyId and groupId are required");
  return { companyId, groupId };
}

function assertExactScope(
  scope: ResearchCorpusScope,
  subjects: ResearchSubject[],
  messages: Array<{ messageId: string; subjectKey: string }>,
  activities: Array<Omit<PersonalActivityRecord, "employeeId">>,
  traces: ResearchTraceRecord[],
  feedback: Array<{ targetMessageId: string }>,
  evaluations: EvaluationCaseRecord[],
): void {
  for (const record of [...subjects, ...traces, ...evaluations]) {
    if (record.companyId !== scope.companyId || record.groupId !== scope.groupId) throw new Error("research corpus source returned a cross-scope record");
  }
  const subjectKeys = new Set(subjects.map((record) => record.subjectKey));
  if (messages.some((record) => !subjectKeys.has(record.subjectKey))) throw new Error("research corpus source returned a message outside the scoped subjects");
  if (activities.some((record) => record.companyId !== scope.companyId || record.groupId !== scope.groupId || !subjectKeys.has(record.subjectKey))) throw new Error("research corpus source returned a cross-scope activity");
  if (traces.some((record) => !subjectKeys.has(record.subjectKey)) || evaluations.some((record) => !subjectKeys.has(record.subjectKey))) throw new Error("research corpus source returned evidence outside the scoped subjects");
  const messageIds = new Set(messages.map((record) => record.messageId));
  if (feedback.some((record) => !messageIds.has(record.targetMessageId))) throw new Error("research corpus source returned feedback outside the scoped messages");
}

function groupBy<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) grouped.set(key(record), [...(grouped.get(key(record)) ?? []), record]);
  return grouped;
}

function uniqueSorted(values: string[]): string[] { return [...new Set(values)].sort(); }
function emptyCoverage(): ResearchCorpusExport["coverage"] { return { subjects: 0, messages: 0, activities: 0, traces: 0, feedback: 0, evaluationCases: 0, messagesWithTrace: 0, messagesMissingTrace: 0 }; }
