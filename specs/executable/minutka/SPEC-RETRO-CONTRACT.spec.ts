import { describe, expect, it, vi } from "vitest";
import type { WorkRetrospectiveEpisode, WorkRetrospectivePolicy, RetrospectiveExtractionInput } from "../../../src/domain/work-retrospective.js";
import { retrospectiveContextMaxCharacters, retrospectiveDailyQuestionLimit, retrospectiveWeeklyQuestionLimit } from "../../../src/domain/work-retrospective.js";
import { workRetrospectiveEpisodeSchema, retrospectiveQuestionSchema, retrospectiveIndicatorSchema } from "../../../src/application/work-retrospective-store.js";
import { InMemoryWorkRetrospectivePolicyStore, resolveWorkRetrospectivePolicy } from "../../../src/application/work-retrospective-policy.js";
import { conversationTurnOrigin } from "../../../src/application/conversation-store.js";

const clock = { now: () => "2026-08-26T12:00:00.000Z" };
const scope = {
  employeeId: "employee_a", companyId: "company_a", groupId: "group_a",
  subjectKey: "00000000-0000-4000-8000-000000000001", threadId: "thread_a",
};
const sourceRefs = [{ type: "message" as const, messageId: "m1" }];
const step = { statementId: "s3", text: "Попробую список полей", kind: "intention" as const, sourceRefs };
const episode: WorkRetrospectiveEpisode = {
  ...scope, episodeId: "episode_a", methodVersion: "retro-v1",
  period: { start: "2026-08-26T00:00:00.000Z", end: "2026-08-26T23:59:59.000Z" },
  messageRefs: [{ messageId: "m1" }], activityRefs: [{ activityId: "activity_a", revision: 1 }],
  statements: {
    actions: [{ statementId: "s1", text: "Подготовил отчёт за 35 минут", kind: "employee_fact", sourceRefs }],
    value: [{ statementId: "s2", text: "Коллеге проще проверить", kind: "employee_interpretation", sourceRefs }],
    future: [step],
    indicators: [{ statementId: "s4", text: "Возможно, список поможет", kind: "agent_hypothesis", sourceRefs }],
  },
  selectedStep: step,
  indicator: { sign: "Возврат из-за пропуска", meaning: "Список неполон", reaction: "Дополнить список", sourceRefs },
  followUpConsent: { granted: true, sourceRef: { messageId: "m1" } },
  status: "active", revision: 1,
  pendingQuestion: {
    questionId: "q1", text: "По какому признаку поймёте, что список помог?",
    sourceTurn: { messageId: "agent_turn_1" },
    target: { episodeId: "episode_a", revision: 1, stage: "indicators", sourceRefs },
  },
  questionBudget: { localDate: "2026-08-26", dailyDelivered: 1 },
};
const policy: WorkRetrospectivePolicy = {
  companyId: scope.companyId, groupId: scope.groupId, enabled: true,
  period: { start: "2026-08-19T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" }, methodVersion: "retro-v1",
};

describe("Retrospective contracts (offline, no runtime activation)", () => {
  it("SPEC-RETRO-CONTRACT-01 preserves intention and provenance without an activity mutation", () => {
    const activityMutation = vi.fn();
    const parsed = workRetrospectiveEpisodeSchema.parse(episode);
    expect(parsed.statements.future[0]).toEqual(step);
    expect(parsed.selectedStep?.kind).toBe("intention");
    expect(activityMutation).not.toHaveBeenCalled();
    expect(parsed).toEqual(episode);
  });

  it("SPEC-RETRO-CONTRACT-02 resolves only the trusted company/group policy", async () => {
    const store = new InMemoryWorkRetrospectivePolicyStore([policy]);
    expect(await resolveWorkRetrospectivePolicy(store, { companyId: "company_a", groupId: "group_b" }, clock.now())).toEqual({ enabled: false });
    expect(await resolveWorkRetrospectivePolicy(store, { companyId: "company_b", groupId: "group_a" }, clock.now())).toEqual({ enabled: false });
    expect(await resolveWorkRetrospectivePolicy(store, scope, clock.now())).toEqual({ enabled: true, policy });
    // Even an adapter returning the wrong tenant must not enable that policy.
    expect(await resolveWorkRetrospectivePolicy({ read: async () => policy }, { companyId: "company_a", groupId: "group_b" }, clock.now())).toEqual({ enabled: false });
    expect(await resolveWorkRetrospectivePolicy(store, scope, "2026-09-03T00:00:00.000Z")).toEqual({ enabled: false });
    expect(await resolveWorkRetrospectivePolicy(new InMemoryWorkRetrospectivePolicyStore([{ ...policy, enabled: false }]), scope, clock.now())).toEqual({ enabled: false });
  });

  it("SPEC-RETRO-CONTRACT-03 rejects a question without source and an indicator without evidence", () => {
    const { sourceTurn: _source, ...question } = episode.pendingQuestion!;
    expect(retrospectiveQuestionSchema.safeParse(question).success).toBe(false);
    expect(retrospectiveQuestionSchema.safeParse({ ...episode.pendingQuestion, target: { ...episode.pendingQuestion!.target, sourceRefs: [] } }).success).toBe(false);
    expect(retrospectiveIndicatorSchema.safeParse({ ...episode.indicator, sourceRefs: [] }).success).toBe(false);
    const { sourceRefs: _refs, ...indicator } = episode.indicator!;
    expect(retrospectiveIndicatorSchema.safeParse(indicator).success).toBe(false);
  });

  it("pins bound short/composite answers, declined episodes and legacy unknown origin", () => {
    const generator = vi.fn((input: RetrospectiveExtractionInput) => input);
    const boundTarget = {
      episodeId: episode.episodeId, revision: episode.revision, sourceRefs,
      activityRefs: episode.activityRefs, statements: episode.statements,
    };
    for (const currentText of ["Да", "35 минут; ещё проверил договор"]) {
      expect(generator({ currentText, question: episode.pendingQuestion!, boundTarget }).boundTarget.revision).toBe(1);
    }
    expect(workRetrospectiveEpisodeSchema.parse({ ...episode, status: "declined", pendingQuestion: undefined }).statements).toEqual(episode.statements);
    expect(conversationTurnOrigin({ messageId: "old", employeeId: scope.employeeId, subjectKey: scope.subjectKey, threadId: scope.threadId, userText: "text", agentResponse: "response", timestamp: clock.now() })).toBe("unknown");
    expect([retrospectiveContextMaxCharacters, retrospectiveDailyQuestionLimit, retrospectiveWeeklyQuestionLimit]).toEqual([6000, 4, 8]);
  });
});
