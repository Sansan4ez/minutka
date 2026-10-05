import type { WorkRetrospectivePolicyStore } from "./work-retrospective-policy.js";
import { isDeepStrictEqual } from "node:util";
import { sanitizeRetrospectiveMetadata } from "./retrospective-event-store.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";
import { sameScope, type RetrospectiveEventStore } from "./retrospective-event-store.js";
import { retrospectiveQuestionSchema, workRetrospectiveEpisodeSchema, type RetrospectiveCommand, type RetrospectiveOutcome, type WorkRetrospectiveStore, type WorkRetrospectiveUseCases } from "./work-retrospective-store.js";
import { retrospectiveContextMaxCharacters, retrospectiveDailyQuestionLimit, retrospectiveWeeklyQuestionLimit, type WorkRetrospectiveEpisode, type WorkRetrospectiveEvent } from "../domain/work-retrospective.js";

export function buildRetrospectiveContext(episode: WorkRetrospectiveEpisode): RetrospectiveOutcome<string> {
  const required = { episodeId: episode.episodeId, revision: episode.revision, question: episode.pendingQuestion, activityRefs: episode.activityRefs };
  const minimum = JSON.stringify(required);
  if (minimum.length > retrospectiveContextMaxCharacters) return { status: "failed", code: "context_budget_error" };
  const full = JSON.stringify({ ...required, statements: episode.statements, selectedStep: episode.selectedStep, indicator: episode.indicator });
  return { status: "applied", value: full.length <= retrospectiveContextMaxCharacters ? full : minimum };
}

/** Pure deterministic reducer shared by both projections. Canonical events remain authoritative. */
export function projectRetrospectiveEvents(events: WorkRetrospectiveEvent[]): WorkRetrospectiveEpisode[] {
  const episodes = new Map<string, WorkRetrospectiveEpisode>();
  const delivered = new Set<string>();
  for (const event of events) {
    const action = event.action;
    let episode = episodes.get(event.episodeId);
    if (action.type === "episode_selected" || action.type === "episode_updated") {
      const previous = episode;
      episode = sanitizeRetrospectiveMetadata(action.episode);
      if (previous) { episode.questionBudget = previous.questionBudget; episode.pendingQuestion = previous.pendingQuestion; }
      episodes.set(event.episodeId, episode);
    }
    if (!episode) continue;
    switch (action.type) {
      case "episode_status_changed": episode.status = action.status; if (action.status !== "active") delete episode.pendingQuestion; break;
      case "question_generated":
        for (const other of episodes.values()) if (other.episodeId !== episode.episodeId) { delete other.pendingQuestion; if (other.status === "active") other.status = "paused"; }
        episode.pendingQuestion = structuredClone(action.question); break;
      case "question_closed":
        if (action.reason === "new_day" && action.localDate) {
          for (const other of episodes.values()) if (other.questionBudget.localDate !== action.localDate) { other.questionBudget.localDate = action.localDate; other.questionBudget.dailyDelivered = 0; delete other.pendingQuestion; }
        }
        if (episode.pendingQuestion?.questionId === action.questionId) delete episode.pendingQuestion;
        if (action.reason === "topic_changed") episode.status = "paused";
        if (action.reason === "declined") episode.status = "declined";
        break;
      case "follow_up_consent_changed": episode.followUpConsent = structuredClone(action.consent); break;
      case "weekly_session_started": episode.questionBudget.weeklySession = { sessionId: action.sessionId, consent: structuredClone(action.consent), delivered: 0 }; break;
      case "response_delivery": {
        const key = `${event.episodeId}:${action.questionId}`;
        if (action.status === "delivered" && action.questionId && !delivered.has(key)) {
          delivered.add(key);
          for (const other of episodes.values()) {
            if (other.questionBudget.localDate !== action.localDate) { other.questionBudget.localDate = action.localDate; other.questionBudget.dailyDelivered = 0; delete other.pendingQuestion; }
          }
          const session = episode.questionBudget.weeklySession;
          if (session?.consent.granted && session.sessionId === action.sessionId) session.delivered++;
          else episode.questionBudget.dailyDelivered++;
        }
        break;
      }
    }
    if (Date.parse(event.timestamp) >= Date.parse(episode.period.end)) delete episode.pendingQuestion;
    episode.revision = event.expectedRevision + 1;
  }
  return [...episodes.values()];
}

export function validateRetrospectiveCommand(command: RetrospectiveCommand, events: WorkRetrospectiveEvent[]): RetrospectiveOutcome<WorkRetrospectiveEpisode> {
  if (command.events.some((event) => !sameScope(event, command.scope))) return { status: "forbidden" };
  const current = projectRetrospectiveEvents(events).find((episode) => episode.episodeId === command.episodeId);
  const replay = command.events.every((event) => events.some((old) => old.sourceMessageId === event.sourceMessageId && old.ordinal === event.ordinal && isDeepStrictEqual(sanitizeRetrospectiveMetadata(old), sanitizeRetrospectiveMetadata(event))));
  if (command.events.length && replay && current) return { status: "replayed", value: current };
  if (command.events.some((event) => !sameScope(event, command.scope) || event.episodeId !== command.episodeId)) return { status: "forbidden" };
  if ((current?.revision ?? 0) !== command.expectedRevision) return { status: "stale" };
  if (!command.events.length) return { status: "failed", code: "validation_error" };
  let revision = command.expectedRevision;
  let accumulated = [...events];
  for (const event of command.events) {
    if (event.expectedRevision !== revision++ || events.some((old) => old.sourceMessageId === event.sourceMessageId && old.ordinal === event.ordinal)) return { status: "stale" };
    const before = projectRetrospectiveEvents(accumulated).find((episode) => episode.episodeId === command.episodeId);
    if (!Number.isFinite(Date.parse(event.timestamp)) || event.version !== 1 || !Number.isInteger(event.ordinal) || event.ordinal < 0) return { status: "failed", code: "validation_error" };
    const action = event.action;
    if (action.type === "question_closed" && action.reason === "new_day" && (!action.localDate || !/^\d{4}-\d{2}-\d{2}$/.test(action.localDate))) return { status: "failed", code: "validation_error" };
    if (action.type === "response_delivery" && action.questionId && (!events.some((old) => old.action.type === "question_generated" && old.action.question.questionId === action.questionId && old.episodeId === event.episodeId) || (before?.questionBudget.weeklySession?.consent.granted && action.sessionId !== before.questionBudget.weeklySession.sessionId))) return { status: "failed", code: "validation_error" };
    if (action.type === "episode_selected" || action.type === "episode_updated") {
      if (!workRetrospectiveEpisodeSchema.safeParse(action.episode).success || !sameScope(action.episode, command.scope) || action.episode.episodeId !== command.episodeId) return { status: "forbidden" };
      if (action.type === "episode_updated" && !before) return { status: "not_found" };
      if (before && action.type === "episode_selected") return { status: "stale" };
      if (action.type === "episode_selected" && (action.episode.pendingQuestion || action.episode.questionBudget.dailyDelivered !== 0 || action.episode.questionBudget.weeklySession)) return { status: "failed", code: "validation_error" };
    } else if (!before) return { status: "not_found" };
    if (action.type === "weekly_session_started" && (!action.consent.granted || before?.questionBudget.weeklySession || projectRetrospectiveEvents(accumulated).some((episode) => episode.questionBudget.weeklySession))) return { status: "failed", code: "validation_error" };
    if (action.type === "question_generated") {
      if (!retrospectiveQuestionSchema.safeParse(action.question).success || action.question.sourceTurn.messageId !== event.sourceMessageId) return { status: "failed", code: "validation_error" };
      if (action.question.target.episodeId !== command.episodeId || action.question.target.revision !== event.expectedRevision) return { status: "stale" };
      const all = projectRetrospectiveEvents(accumulated);
      const budget = before!.questionBudget;
      const weekly = budget.weeklySession;
      const count = weekly?.consent.granted ? all.filter((e) => e.questionBudget.weeklySession?.sessionId === weekly.sessionId).reduce((sum, e) => sum + (e.questionBudget.weeklySession?.delivered ?? 0), 0) : all.filter((e) => e.questionBudget.localDate === budget.localDate).reduce((sum, e) => sum + e.questionBudget.dailyDelivered, 0);
      if (Date.parse(event.timestamp) >= Date.parse(before!.period.end) || before!.pendingQuestion || before!.status !== "active" || count >= (weekly?.consent.granted ? retrospectiveWeeklyQuestionLimit : retrospectiveDailyQuestionLimit)) return { status: "failed", code: "validation_error" };
      const bound = [...before!.messageRefs.map((ref) => ({ type: "message" as const, ...ref })), ...before!.activityRefs.map((ref) => ({ type: "activity" as const, ...ref }))];
      if (!action.question.target.sourceRefs.length || action.question.target.sourceRefs.some((ref) => !bound.some((source) => JSON.stringify(source) === JSON.stringify(ref)))) return { status: "forbidden" };
      const context = buildRetrospectiveContext({ ...before!, pendingQuestion: action.question });
      if (context.status === "failed") return context;
    }
    accumulated = [...accumulated, event];
  }
  const value = projectRetrospectiveEvents(accumulated).find((episode) => episode.episodeId === command.episodeId);
  if (value && !workRetrospectiveEpisodeSchema.safeParse(value).success) return { status: "failed", code: "validation_error" };
  return value ? { status: "applied", value } : { status: "not_found" };
}

/** No synthetic turns: callers bind commands to the actual employee/agent response. */
export function createWorkRetrospectiveService(store: WorkRetrospectiveStore, conversations: ConversationStore, policies?: WorkRetrospectivePolicyStore): WorkRetrospectiveUseCases & { readInvalidatedQuestion(request: { scope: import("../domain/work-retrospective.js").RetrospectiveScope; episodeId: string }): Promise<string | undefined>; readContext(request: { scope: import("../domain/work-retrospective.js").RetrospectiveScope; localDate: string; now: string; enabled: boolean }): Promise<RetrospectiveOutcome<string>>; applyTurn(command: RetrospectiveCommand, turn: ConversationTurn): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode>> } {
  const visibleEpisode = async (episode: WorkRetrospectiveEpisode) => {
    const policy = await policies?.read(episode);
    if (!episode.pendingQuestion || !policy?.invalidatedAt) return episode;
    const events = await store.readEvents({ scope: episode, episodeId: episode.episodeId, limit: 100 });
    const generated = "value" in events ? events.value.find(e => e.action.type === "question_generated" && e.action.question.questionId === episode.pendingQuestion!.questionId) : undefined;
    if (!generated || Date.parse(generated.timestamp) <= Date.parse(policy.invalidatedAt)) {
      const visible = structuredClone(episode);
      delete visible.pendingQuestion;
      return visible;
    }
    return episode;
  };
  const readEpisodes: WorkRetrospectiveUseCases["readEpisodes"] = async request => {
    const result = await store.readEpisodes(request);
    return "value" in result ? { ...result, value: await Promise.all(result.value.map(visibleEpisode)) } : result;
  };
  const applyTurn = async (command: RetrospectiveCommand, turn: ConversationTurn): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode>> => {
    const policy = await policies?.read(command.scope);
    if (policies && command.events.some(e => e.action.type !== "question_closed" || e.action.reason !== "policy_disabled")
      && (!policy?.enabled || command.events.some(e => policy.invalidatedAt && Date.parse(e.timestamp) <= Date.parse(policy.invalidatedAt)))) return { status: "stale" };
    const current = await store.readEpisode(command);
    if ("value" in current && current.value.pendingQuestion && !(await visibleEpisode(current.value)).pendingQuestion
      && !command.events.some(e => e.action.type === "question_closed" && e.action.reason === "policy_disabled")) return { status: "stale" };
    const result = await store.appendTurnWithEvents({ ...command, turn });
    if (!("value" in result)) return result;
    const projection = await store.rebuild(command);
    return projection.status === "applied" ? { ...projection, status: result.status } : projection;
  };
  return { async readInvalidatedQuestion(request) {
      const result = await store.readEpisode(request);
      if (!("value" in result) || !result.value.pendingQuestion) return undefined;
      return (await visibleEpisode(result.value)).pendingQuestion ? undefined : result.value.pendingQuestion.questionId;
    }, async readEpisode(request) {
      const result = await store.readEpisode(request);
      return "value" in result ? { ...result, value: await visibleEpisode(result.value) } : result;
    }, readEpisodes, applyTurn,
    async readContext(request) {
      const result = await readEpisodes({ scope: request.scope, limit: 100 });
      if (!("value" in result)) return result;
      const visible = result.value.map((value) => {
        const episode = structuredClone(value);
        if (!request.enabled || episode.questionBudget.localDate !== request.localDate || Date.parse(request.now) >= Date.parse(episode.period.end)) delete episode.pendingQuestion;
        return episode;
      });
      if (!request.enabled) return { status: "applied", value: "{}" };
      const active = visible.find((episode) => episode.status === "active");
      const followUp = visible.find((episode) => episode.episodeId !== active?.episodeId && episode.followUpConsent?.granted && episode.selectedStep);
      const activeContext = active ? buildRetrospectiveContext(active) : { status: "applied" as const, value: "null" };
      if (!("value" in activeContext)) return activeContext;
      const minimum = JSON.stringify({ active: JSON.parse(activeContext.value) });
      if (minimum.length > retrospectiveContextMaxCharacters) return { status: "failed", code: "context_budget_error" };
      const full = JSON.stringify({ active: JSON.parse(activeContext.value), followUp: followUp && { episodeId: followUp.episodeId, revision: followUp.revision, selectedStep: followUp.selectedStep, indicator: followUp.indicator } });
      return { status: "applied", value: full.length <= retrospectiveContextMaxCharacters ? full : minimum };
    },
    async apply(command) {
      const source = command.events[0]?.sourceMessageId;
      if (!source) return { status: "failed", code: "validation_error" };
      const turn = await conversations.getTurnByMessageId({ ...command.scope, messageId: source });
      return turn ? applyTurn(command, turn) : { status: "not_found" };
    } };
}

export type RetrospectiveCanonicalStore = ConversationStore & RetrospectiveEventStore;
