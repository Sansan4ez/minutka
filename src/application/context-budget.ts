import { countUnicodeCodePoints, maxChatInputCharacters } from "../shared/chat-limits.js";

export const contextSourceIds = [
  "base_instructions",
  "agent_manual",
  "profile",
  "context",
  "records",
  "inbox",
  "history",
  "actions",
] as const;

export type ContextSourceId = typeof contextSourceIds[number];

export type ContextSourceBudget = {
  id: ContextSourceId;
  priority: number;
  ceiling: number;
};

export type ContextBudgetConfig = {
  total: number;
  responseReserve: number;
  sources: readonly ContextSourceBudget[];
  projectionLimits: {
    contextDocuments: number;
    contextDocumentCharacters: number;
    records: number;
    recordCharacters: number;
    historyTurns: number;
    historyTurnCharacters: number;
    routingTurns: number;
    routingCurrentTextCharacters: number;
    routingTurnFieldCharacters: number;
    insightTurns: number;
    insightFieldCharacters: number;
    insights: number;
    feedback: number;
    runCurrent: number;
    runRecent: number;
  };
  documentTools: {
    listDefault: number;
    listMaximum: number;
    readDefaultCharacters: number;
    readMaximumCharacters: number;
    searchDefault: number;
    searchMaximum: number;
    searchSnippetCharacters: number;
  };
};

export type ContextBudgetOverrides = {
  total?: number;
  responseReserve?: number;
  sources?: Partial<Record<ContextSourceId, number>>;
  projectionLimits?: Partial<ContextBudgetConfig["projectionLimits"]>;
  documentTools?: Partial<ContextBudgetConfig["documentTools"]>;
};

export type ContextSection = {
  sourceId: ContextSourceId;
  content: string;
};

export type ContextBudgetResult = {
  text: string;
  used: number;
  available: number;
  omittedSourceIds: ContextSourceId[];
};

/** Canonical request-context limits. Character counts are Unicode code points. */
export const defaultContextBudget: ContextBudgetConfig = {
  total: 48_000,
  responseReserve: 8_000,
  sources: [
    { id: "base_instructions", priority: 1, ceiling: 2_000 },
    { id: "agent_manual", priority: 2, ceiling: 33_000 },
    { id: "profile", priority: 3, ceiling: 4_000 },
    { id: "context", priority: 4, ceiling: 16_000 },
    { id: "records", priority: 5, ceiling: 12_000 },
    { id: "inbox", priority: 6, ceiling: 8_000 },
    { id: "history", priority: 7, ceiling: 12_000 },
    { id: "actions", priority: 8, ceiling: 8_000 },
  ],
  projectionLimits: {
    contextDocuments: 12,
    contextDocumentCharacters: 4_000,
    records: 24,
    recordCharacters: 1_000,
    historyTurns: 10,
    historyTurnCharacters: 6_000,
    routingTurns: 3,
    routingCurrentTextCharacters: 4_096,
    routingTurnFieldCharacters: 700,
    insightTurns: 5,
    insightFieldCharacters: 2_000,
    insights: 20,
    feedback: 20,
    runCurrent: 50,
    runRecent: 50,
  },
  documentTools: {
    listDefault: 20,
    listMaximum: 50,
    readDefaultCharacters: 4_000,
    readMaximumCharacters: 8_000,
    searchDefault: 10,
    searchMaximum: 20,
    searchSnippetCharacters: 500,
  },
};

export function createContextBudgetConfig(overrides: ContextBudgetOverrides = {}): ContextBudgetConfig {
  const sourceOverrides = overrides.sources ?? {};
  for (const id of Object.keys(sourceOverrides)) {
    if (!contextSourceIds.includes(id as ContextSourceId)) throw new Error(`unknown context budget source: ${id}`);
  }
  const total = overrides.total ?? defaultContextBudget.total;
  const responseReserve = overrides.responseReserve ?? defaultContextBudget.responseReserve;
  assertNonNegativeInteger(total, "context budget total");
  if (total === 0) throw new Error("context budget total must be greater than zero");
  assertNonNegativeInteger(responseReserve, "context response reserve");
  if (responseReserve > total) throw new Error("context response reserve must not exceed total budget");

  const sources = defaultContextBudget.sources.map((source) => {
    const ceiling = sourceOverrides[source.id] ?? source.ceiling;
    assertNonNegativeInteger(ceiling, `context source ${source.id} ceiling`);
    if (ceiling > total) throw new Error(`context source ${source.id} ceiling must not exceed total budget`);
    return { ...source, ceiling };
  });
  const projectionLimits = { ...defaultContextBudget.projectionLimits, ...overrides.projectionLimits };
  const documentTools = { ...defaultContextBudget.documentTools, ...overrides.documentTools };
  for (const [name, value] of Object.entries(projectionLimits)) assertNonNegativeInteger(value, `context projection limit ${name}`);
  for (const [name, value] of Object.entries(documentTools)) assertNonNegativeInteger(value, `document tool limit ${name}`);
  assertPositiveLimits(projectionLimits, "context projection limit");
  assertPositiveLimits(documentTools, "document tool limit");
  if (documentTools.listDefault > documentTools.listMaximum) throw new Error("document list default must not exceed its maximum");
  if (documentTools.readDefaultCharacters > documentTools.readMaximumCharacters) throw new Error("document read default must not exceed its maximum");
  if (documentTools.searchDefault > documentTools.searchMaximum) throw new Error("document search default must not exceed its maximum");
  if (projectionLimits.contextDocumentCharacters > sourceCeiling(sources, "context")) throw new Error("context document limit must not exceed the context source ceiling");
  if (projectionLimits.recordCharacters > sourceCeiling(sources, "records")) throw new Error("record limit must not exceed the records source ceiling");
  if (projectionLimits.historyTurnCharacters > sourceCeiling(sources, "history")) throw new Error("history turn limit must not exceed the history source ceiling");
  const trustedCeiling = trustedControlPlaneCeiling(sources);
  if (trustedCeiling + maxChatInputCharacters + responseReserve > total) {
    throw new Error(
      `trusted context ceilings (${trustedCeiling}) plus maximum user input (${maxChatInputCharacters}) and response reserve (${responseReserve}) must not exceed total budget (${total})`,
    );
  }
  return {
    ...defaultContextBudget,
    total,
    responseReserve,
    sources,
    projectionLimits,
    documentTools,
  };
}

const projectionLimitEnv = {
  contextDocuments: "ASSISTANT_CONTEXT_DOCUMENTS",
  contextDocumentCharacters: "ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS",
  records: "ASSISTANT_CONTEXT_RECORDS",
  recordCharacters: "ASSISTANT_CONTEXT_RECORD_CHARACTERS",
  historyTurns: "ASSISTANT_CONTEXT_HISTORY_TURNS",
  historyTurnCharacters: "ASSISTANT_CONTEXT_HISTORY_TURN_CHARACTERS",
  routingTurns: "ASSISTANT_CONTEXT_ROUTING_TURNS",
  routingCurrentTextCharacters: "ASSISTANT_CONTEXT_ROUTING_CURRENT_TEXT_CHARACTERS",
  routingTurnFieldCharacters: "ASSISTANT_CONTEXT_ROUTING_TURN_FIELD_CHARACTERS",
  insightTurns: "ASSISTANT_CONTEXT_INSIGHT_TURNS",
  insightFieldCharacters: "ASSISTANT_CONTEXT_INSIGHT_FIELD_CHARACTERS",
  insights: "ASSISTANT_CONTEXT_INSIGHTS",
  feedback: "ASSISTANT_CONTEXT_FEEDBACK",
  runCurrent: "ASSISTANT_CONTEXT_RUN_CURRENT",
  runRecent: "ASSISTANT_CONTEXT_RUN_RECENT",
} as const;

const documentToolEnv = {
  listDefault: "ASSISTANT_DOCUMENT_LIST_DEFAULT",
  listMaximum: "ASSISTANT_DOCUMENT_LIST_MAXIMUM",
  readDefaultCharacters: "ASSISTANT_DOCUMENT_READ_DEFAULT_CHARACTERS",
  readMaximumCharacters: "ASSISTANT_DOCUMENT_READ_MAXIMUM_CHARACTERS",
  searchDefault: "ASSISTANT_DOCUMENT_SEARCH_DEFAULT",
  searchMaximum: "ASSISTANT_DOCUMENT_SEARCH_MAXIMUM",
  searchSnippetCharacters: "ASSISTANT_DOCUMENT_SEARCH_SNIPPET_CHARACTERS",
} as const;

export function contextBudgetConfigFromEnv(env: NodeJS.ProcessEnv): ContextBudgetConfig {
  const sources: Partial<Record<ContextSourceId, number>> = {};
  for (const id of contextSourceIds) {
    const value = env[`ASSISTANT_CONTEXT_SOURCE_${id.toUpperCase()}_CHARACTERS`];
    if (value !== undefined) sources[id] = parseEnvInteger(value, `ASSISTANT_CONTEXT_SOURCE_${id.toUpperCase()}_CHARACTERS`);
  }
  const projectionLimits = parseEnvRecord(env, projectionLimitEnv);
  const documentTools = parseEnvRecord(env, documentToolEnv);
  return createContextBudgetConfig({
    ...(env.ASSISTANT_CONTEXT_TOTAL_CHARACTERS === undefined ? {} : { total: parseEnvInteger(env.ASSISTANT_CONTEXT_TOTAL_CHARACTERS, "ASSISTANT_CONTEXT_TOTAL_CHARACTERS") }),
    ...(env.ASSISTANT_CONTEXT_RESPONSE_RESERVE_CHARACTERS === undefined ? {} : { responseReserve: parseEnvInteger(env.ASSISTANT_CONTEXT_RESPONSE_RESERVE_CHARACTERS, "ASSISTANT_CONTEXT_RESPONSE_RESERVE_CHARACTERS") }),
    ...(Object.keys(sources).length === 0 ? {} : { sources }),
    ...(Object.keys(projectionLimits).length === 0 ? {} : { projectionLimits }),
    ...(Object.keys(documentTools).length === 0 ? {} : { documentTools }),
  });
}

/**
 * Keeps complete sections in priority order. Trusted manual content is never
 * displaced by owner data; lower-priority sections are omitted on overflow.
 */
export function applyContextBudget(input: {
  sections: readonly ContextSection[];
  userInput: string;
  config?: ContextBudgetConfig;
}): ContextBudgetResult {
  const config = input.config ?? defaultContextBudget;
  const sourceRegistry = new Map(config.sources.map((source) => [source.id, source]));
  if (sourceRegistry.size !== contextSourceIds.length) throw new Error("context budget registry must contain every source exactly once");
  const inputCharacters = countUnicodeCharacters(input.userInput);
  if (inputCharacters > maxChatInputCharacters) throw new Error(`current user input exceeds the ${maxChatInputCharacters}-character maximum`);
  const available = config.total - config.responseReserve - inputCharacters;
  if (available < 0) throw new Error("current user input and response reserve exceed the total context budget");

  const selected: string[] = [];
  const omittedSourceIds: ContextSourceId[] = [];
  let used = 0;
  let lowerPrioritySectionsOmitted = false;
  for (const section of input.sections
    .filter(({ content }) => content.length > 0)
    .map((section, index) => ({ ...section, index, source: sourceRegistry.get(section.sourceId) }))
    .sort((left, right) => {
      if (!left.source || !right.source) throw new Error("context section references an unregistered source");
      return left.source.priority - right.source.priority || left.index - right.index;
    })) {
    if (!section.source) throw new Error(`unknown context budget source: ${section.sourceId}`);
    if (lowerPrioritySectionsOmitted) {
      omittedSourceIds.push(section.sourceId);
      continue;
    }
    const contentCharacters = countUnicodeCharacters(section.content);
    // Owner projections enforce their data ceilings before rendering. Rendered
    // wrappers/metadata are counted only against the aggregate request budget,
    // otherwise a projection at its exact data ceiling could be dropped solely
    // because of its safety markup.
    if (contentCharacters > section.source.ceiling && isTrustedControlPlane(section.sourceId)) {
      throw new Error(`trusted ${section.sourceId} exceeds its ${section.source.ceiling}-character ceiling`);
    }
    const separatorCharacters = selected.length === 0 ? 0 : 2;
    if (used + separatorCharacters + contentCharacters > available) {
      if (isTrustedControlPlane(section.sourceId)) throw new Error(`trusted ${section.sourceId} does not fit the available request context budget`);
      omittedSourceIds.push(section.sourceId);
      lowerPrioritySectionsOmitted = true;
      continue;
    }
    selected.push(section.content);
    used += separatorCharacters + contentCharacters;
  }
  return { text: selected.join("\n\n"), used, available, omittedSourceIds };
}

export function sourceCharacterCeiling(config: ContextBudgetConfig, id: ContextSourceId): number {
  const source = config.sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`missing context budget source: ${id}`);
  return source.ceiling;
}

export function assertContextSourceContentFits(input: {
  config: ContextBudgetConfig;
  sourceId: ContextSourceId;
  content: string;
  label?: string;
}): void {
  const characters = countUnicodeCharacters(input.content);
  const ceiling = sourceCharacterCeiling(input.config, input.sourceId);
  if (characters > ceiling) {
    throw new Error(`${input.label ?? `context source ${input.sourceId}`} has ${characters} Unicode characters and exceeds the ${ceiling}-character ${input.sourceId} ceiling`);
  }
}

export function countUnicodeCharacters(value: string): number {
  return countUnicodeCodePoints(value);
}

function sourceCeiling(sources: readonly ContextSourceBudget[], id: ContextSourceId): number {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`missing context budget source: ${id}`);
  return source.ceiling;
}

function trustedControlPlaneCeiling(sources: readonly ContextSourceBudget[]): number {
  const ceilings = sources.filter(({ id }) => isTrustedControlPlane(id)).map(({ ceiling }) => ceiling);
  const separators = Math.max(0, ceilings.filter((ceiling) => ceiling > 0).length - 1) * countUnicodeCharacters("\n\n");
  return ceilings.reduce((sum, ceiling) => sum + ceiling, 0) + separators;
}

function isTrustedControlPlane(sourceId: ContextSourceId): boolean {
  return sourceId === "base_instructions" || sourceId === "agent_manual";
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function assertPositiveLimits(values: Record<string, number>, prefix: string): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === 0) throw new Error(`${prefix} ${name} must be greater than zero`);
  }
}

function parseEnvRecord<T extends Record<string, string>>(env: NodeJS.ProcessEnv, names: T): Partial<Record<keyof T, number>> {
  const result: Partial<Record<keyof T, number>> = {};
  for (const key of Object.keys(names) as Array<keyof T>) {
    const name = names[key]!;
    if (env[name] !== undefined) result[key] = parseEnvInteger(env[name]!, name);
  }
  return result;
}

function parseEnvInteger(value: string, name: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}
