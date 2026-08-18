import { z } from "zod";
import type { ResearchTraceStore } from "./research-trace-store.js";
import { randomIdGenerator, systemClock, type Clock } from "./runtime-primitives.js";

export const evaluationCaseSchemaVersion = "research-evaluation-case/v1" as const;

export const usefulnessLabels = ["useful", "partly_useful", "not_useful", "not_applicable"] as const;
export const accuracyLabels = ["accurate", "partly_accurate", "inaccurate", "not_applicable"] as const;
export const clarificationLabels = ["needed", "not_needed", "unclear"] as const;
export const extractionCorrectnessLabels = ["correct", "partly_correct", "incorrect", "not_applicable"] as const;

export type EvaluationHumanLabels = {
  usefulness: (typeof usefulnessLabels)[number];
  accuracy: (typeof accuracyLabels)[number];
  clarification: (typeof clarificationLabels)[number];
  extractionCorrectness: (typeof extractionCorrectnessLabels)[number];
  notes?: string;
};

export type EvaluationCaseRecord = {
  schemaVersion: typeof evaluationCaseSchemaVersion;
  caseId: string;
  companyId: string;
  groupId: string;
  subjectKey: string;
  traceId: string;
  requestId: string;
  messageId: string;
  promptVersion: string;
  processVersion: string;
  taxonomyVersion: string;
  model: string;
  labels: EvaluationHumanLabels;
  createdAt: string;
};

export type EvaluationCaseScope = { companyId: string; groupId: string };

export type EvaluationCaseStore = {
  create(record: EvaluationCaseRecord): Promise<void>;
  get(input: EvaluationCaseScope & { caseId: string }): Promise<EvaluationCaseRecord | undefined>;
  list(input: EvaluationCaseScope): Promise<EvaluationCaseRecord[]>;
};

const labelsSchema = z.strictObject({
  usefulness: z.enum(usefulnessLabels),
  accuracy: z.enum(accuracyLabels),
  clarification: z.enum(clarificationLabels),
  extractionCorrectness: z.enum(extractionCorrectnessLabels),
  notes: z.string().trim().min(1).max(10_000).optional(),
});

const evaluationCaseSchema = z.strictObject({
  schemaVersion: z.literal(evaluationCaseSchemaVersion),
  caseId: z.string().trim().min(1),
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1),
  traceId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1),
  processVersion: z.string().trim().min(1),
  taxonomyVersion: z.string().trim().min(1),
  model: z.string().trim().min(1),
  labels: labelsSchema,
  createdAt: z.string().datetime(),
});

const createEvaluationCaseSchema = z.strictObject({
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  traceId: z.string().trim().min(1),
  labels: labelsSchema,
});

export type CreateEvaluationCaseInput = z.input<typeof createEvaluationCaseSchema>;

export class EvaluationTraceNotFoundError extends Error {
  constructor() {
    super("research trace not found in the requested company/group scope");
    this.name = "EvaluationTraceNotFoundError";
  }
}

export class ResearchEvaluationService {
  constructor(
    private readonly store: EvaluationCaseStore,
    private readonly traces: Pick<ResearchTraceStore, "get">,
    private readonly clock: Clock = systemClock,
    private readonly caseId: () => string = randomIdGenerator.evaluationCaseId!,
  ) {}

  async create(input: CreateEvaluationCaseInput): Promise<EvaluationCaseRecord> {
    const parsed = createEvaluationCaseSchema.parse(input);
    const trace = await this.traces.get({ companyId: parsed.companyId, groupId: parsed.groupId, traceId: parsed.traceId });
    if (!trace) throw new EvaluationTraceNotFoundError();
    const record = parseEvaluationCase({
      schemaVersion: evaluationCaseSchemaVersion,
      caseId: this.caseId(),
      companyId: trace.companyId,
      groupId: trace.groupId,
      subjectKey: trace.subjectKey,
      traceId: trace.traceId,
      requestId: trace.requestId,
      messageId: trace.messageId,
      promptVersion: trace.promptVersion,
      processVersion: trace.processVersion,
      taxonomyVersion: trace.taxonomyVersion,
      model: trace.model,
      labels: parsed.labels,
      createdAt: this.clock.now(),
    });
    await this.store.create(record);
    return record;
  }

  get(input: EvaluationCaseScope & { caseId: string }): Promise<EvaluationCaseRecord | undefined> {
    return this.store.get(input);
  }
}

export function parseEvaluationCase(value: unknown): EvaluationCaseRecord {
  return evaluationCaseSchema.parse(value);
}
