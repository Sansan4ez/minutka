import { z } from "zod";
import type { PersonalActivityRecord } from "./activity-collection.js";
import { countUnicodeCodePoints } from "../shared/chat-limits.js";
import type { ResearchEvidenceReadService } from "./research-evidence-read.js";
import { roleSectionForSuggest, type RoutineDirectory, type RoutineDirectorySuggestSection as DirectorySuggestSection } from "./routine-directory.js";
import { quickWinAssignmentSchema, quickWinCatalog, findQuickWin } from "./quick-wins.js";
import { routineKey } from "./own-activity-window.js";
import { workCategories, workCategorySchema } from "../domain/work-categories.js";

export const routineDirectorySuggestSchemaVersion = "minutka-routine-directory-suggest/v1" as const;

const attachProposalSchema = z.strictObject({ kind: z.literal("attach"), routineId: z.string().trim().min(1) });
const createProposalSchema = z.strictObject({
  kind: z.literal("create"),
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().min(1).max(500),
  workCategory: workCategorySchema,
  quickWin: quickWinAssignmentSchema,
});
const freeProposalSchema = z.strictObject({ kind: z.literal("free") });
export const routineDirectorySuggestionTransportSchema = z.strictObject({
  routineKey: z.string().trim().min(1),
  proposal: z.discriminatedUnion("kind", [attachProposalSchema, createProposalSchema, freeProposalSchema]),
  supportingPhrase: z.string().trim().min(1),
});

export type RoutineDirectorySuggestionTransport = z.infer<typeof routineDirectorySuggestionTransportSchema>;
export type RoutineDirectorySuggestSection = DirectorySuggestSection;
export type RoutineDirectorySuggestInput = { companyId: string; groupId: string; directory: RoutineDirectory };
export type RoutineDirectoryFreeRoutine = {
  routineKey: string;
  observations: number;
  contributors: number;
  activeDates: number;
  messages: string[];
};
export type RoutineDirectorySuggestionGeneratorInput = {
  roleId: string;
  roleSection: RoutineDirectorySuggestSection;
  catalog: Array<Pick<(typeof quickWinCatalog)[number], "id" | "typicalFor" | "title">>;
  workCategories: typeof workCategories;
  freeRoutines: RoutineDirectoryFreeRoutine[];
};
export type RoutineDirectorySuggestionGenerator = (
  input: RoutineDirectorySuggestionGeneratorInput,
) => Promise<RoutineDirectorySuggestionTransport[] | RoutineDirectorySuggestionTransport | { suggestions: RoutineDirectorySuggestionTransport[] }>;

export type RoutineDirectorySuggestion = {
  routineKey: string;
  counts: { observations: number; contributors: number; activeDates: number };
  proposal: RoutineDirectorySuggestionTransport["proposal"];
  supportingPhrase?: string;
  supportingPhraseStatus: "ok" | "no_supporting_phrase";
};
export type RoutineDirectorySuggestRole = {
  roleId: string;
  suggestions: RoutineDirectorySuggestion[];
};
export type RoutineDirectorySuggestReviewPack = {
  schemaVersion: typeof routineDirectorySuggestSchemaVersion;
  companyId: string;
  groupId: string;
  directoryVersion: string;
  roles: RoutineDirectorySuggestRole[];
};

type RoutineEvidenceRead = Pick<ResearchEvidenceReadService, "listRoutineEvidence">;

type ActivityEvidence = Omit<PersonalActivityRecord, "employeeId">;
type MessageEvidence = { messageId: string; subjectKey: string; userText: string; agentResponse: string; timestamp: string };

export class RoutineDirectorySuggestService {
  constructor(
    private readonly evidenceRead: RoutineEvidenceRead,
    private readonly generate: RoutineDirectorySuggestionGenerator,
  ) {}

  async suggest(input: RoutineDirectorySuggestInput): Promise<RoutineDirectorySuggestReviewPack> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");

    const evidence = await this.evidenceRead.listRoutineEvidence({ companyId, groupId });
    const messagesById = new Map(evidence.messages.map((message) => [message.messageId, message]));
    const groups = groupFreeActivities(evidence.activities.filter(isActiveFreeActivity), messagesById);
    const roles: RoutineDirectorySuggestRole[] = [];

    for (const [roleId, freeRoutines] of groups.entries()) {
      const roleSection = roleSectionForSuggest(input.directory, roleId);
      const transport = await this.generate({
        roleId,
        roleSection,
        catalog: quickWinCatalog.map(({ id, typicalFor, title }) => ({ id, typicalFor, title })),
        workCategories,
        freeRoutines,
      });
      const suggestions = normalizeGeneratorResult(transport, freeRoutines, roleSection);
      roles.push({
        roleId,
        suggestions: freeRoutines.map((freeRoutine) => {
          const generated = suggestions.get(freeRoutine.routineKey)!;
          const supportingPhrase = validSupportingPhrase(generated.supportingPhrase, freeRoutine.messages);
          return {
            routineKey: freeRoutine.routineKey,
            counts: {
              observations: freeRoutine.observations,
              contributors: freeRoutine.contributors,
              activeDates: freeRoutine.activeDates,
            },
            proposal: generated.proposal,
            ...(supportingPhrase ? { supportingPhrase } : {}),
            supportingPhraseStatus: supportingPhrase ? "ok" : "no_supporting_phrase",
          };
        }),
      });
    }

    roles.sort((left, right) => left.roleId.localeCompare(right.roleId));
    for (const role of roles) role.suggestions.sort((left, right) => left.routineKey.localeCompare(right.routineKey));
    return {
      schemaVersion: routineDirectorySuggestSchemaVersion,
      companyId,
      groupId,
      directoryVersion: input.directory.version,
      roles,
    };
  }
}

function isActiveFreeActivity(activity: ActivityEvidence): boolean {
  return (activity.status ?? "active") === "active"
    && activity.routineId === undefined
    && activity.routineLabel !== undefined;
}

function groupFreeActivities(
  activities: ActivityEvidence[],
  messagesById: Map<string, MessageEvidence>,
): Map<string, RoutineDirectoryFreeRoutine[]> {
  const byRole = new Map<string, Map<string, { activities: ActivityEvidence[]; messages: string[] }>>();
  for (const activity of activities) {
    const key = routineKey(activity.routineLabel!);
    if (!key) continue;
    const role = byRole.get(activity.roleId) ?? new Map();
    const group = role.get(key) ?? { activities: [], messages: [] };
    group.activities.push(activity);
    if (activity.sourceMessageId) {
      const message = messagesById.get(activity.sourceMessageId);
      if (message && !group.messages.includes(message.userText)) group.messages.push(message.userText);
    }
    role.set(key, group);
    byRole.set(activity.roleId, role);
  }
  return new Map([...byRole.entries()].map(([roleId, groups]) => [roleId, [...groups.entries()].map(([key, group]) => ({
    routineKey: key,
    observations: group.activities.length,
    contributors: new Set(group.activities.map((activity) => activity.subjectKey)).size,
    activeDates: new Set(group.activities.map((activity) => activity.activityDate)).size,
    messages: group.messages,
  })).sort((left, right) => left.routineKey.localeCompare(right.routineKey))]));
}

function normalizeGeneratorResult(
  result: Awaited<ReturnType<RoutineDirectorySuggestionGenerator>>,
  freeRoutines: RoutineDirectoryFreeRoutine[],
  roleSection: RoutineDirectorySuggestSection,
): Map<string, RoutineDirectorySuggestionTransport> {
  const candidate = Array.isArray(result) ? result : "suggestions" in result ? result.suggestions : [result];
  const parsed = candidate.map((value) => routineDirectorySuggestionTransportSchema.parse(value));
  const expected = new Set(freeRoutines.map(({ routineKey }) => routineKey));
  const byKey = new Map<string, RoutineDirectorySuggestionTransport>();
  for (const suggestion of parsed) {
    if (!expected.has(suggestion.routineKey)) throw new Error(`suggestion returned an unknown routine key ${JSON.stringify(suggestion.routineKey)}`);
    if (byKey.has(suggestion.routineKey)) throw new Error(`duplicate suggestion for routine key ${JSON.stringify(suggestion.routineKey)}`);
    validateProposal(suggestion, roleSection);
    byKey.set(suggestion.routineKey, suggestion);
  }
  if (byKey.size !== expected.size) throw new Error("suggestion generator did not return one proposal for every free routine");
  return byKey;
}

function validateProposal(suggestion: RoutineDirectorySuggestionTransport, roleSection: RoutineDirectorySuggestSection): void {
  if (suggestion.proposal.kind === "attach") {
    const routineId = suggestion.proposal.routineId;
    if (!roleSection.entries.some(({ id }) => id === routineId)) {
      throw new Error(`suggestion attached an unknown routine id ${JSON.stringify(routineId)}`);
    }
  }
  if (suggestion.proposal.kind === "create" && suggestion.proposal.quickWin !== "deep_dive" && !findQuickWin(suggestion.proposal.quickWin)) {
    throw new Error(`suggestion returned an unknown quick win ${JSON.stringify(suggestion.proposal.quickWin)}`);
  }
}

function validSupportingPhrase(phrase: string, messages: string[]): string | undefined {
  const normalized = phrase.trim();
  if (!normalized || countUnicodeCodePoints(normalized) > 120) return undefined;
  return messages.some((message) => message.includes(normalized) && message.trim() !== normalized)
    ? normalized
    : undefined;
}
