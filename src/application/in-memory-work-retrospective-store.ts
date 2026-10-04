import type { WorkRetrospectiveEpisode, RetrospectiveScope } from "../domain/work-retrospective.js";
import { sameScope } from "./retrospective-event-store.js";
import { projectRetrospectiveEvents, validateRetrospectiveCommand, type RetrospectiveCanonicalStore } from "./work-retrospective-service.js";
import type { WorkRetrospectiveStore, RetrospectiveOutcome } from "./work-retrospective-store.js";

export type RetrospectiveProjection = {
  replace(scope: RetrospectiveScope, episodes: WorkRetrospectiveEpisode[]): Promise<void>;
};
const validLimit = (limit: number) => Number.isInteger(limit) && limit > 0 && limit <= 100;
/** Replay reads the durable ledger, never a process-local question counter. */
export function createRetrospectiveStore(canonical: RetrospectiveCanonicalStore, projection: RetrospectiveProjection): WorkRetrospectiveStore {
  const load = async (scope: RetrospectiveScope) => {
    const events = await canonical.readEvents({ scope, limit: 10001 });
    // Never silently rebuild a truncated ledger.
    if (events.length > 10000) throw new Error("retrospective ledger capacity exceeded");
    return events;
  };
  const failure = (): RetrospectiveOutcome<never> => ({ status: "failed", code: "persistence_error" });
  const rebuild: WorkRetrospectiveStore["rebuild"] = async (request) => {
    try {
      const episodes = projectRetrospectiveEvents(await load(request.scope));
      await projection.replace(request.scope, episodes);
      const value = episodes.find((episode) => episode.episodeId === request.episodeId);
      return value ? { status: "applied", value: structuredClone(value) } : { status: "not_found" };
    } catch { return failure(); }
  };
  // Serialize local writers: concurrent-instance coordination is outside the pilot scope.
  let tail = Promise.resolve();
  return {
    rebuild, readEpisode: rebuild,
    async readEpisodes(request) {
      if (!validLimit(request.limit)) return { status: "failed", code: "validation_error" };
      try {
        const episodes = projectRetrospectiveEvents(await load(request.scope));
        await projection.replace(request.scope, episodes);
        return { status: "applied", value: episodes.filter((episode) => !request.period || (episode.period.start <= request.period.end && episode.period.end >= request.period.start)).slice(-request.limit).reverse() };
      } catch { return failure(); }
    },
    async readEvents(request) {
      if (!validLimit(request.limit)) return { status: "failed", code: "validation_error" };
      try { return { status: "applied", value: await canonical.readEvents(request) }; } catch { return failure(); }
    },
    async appendTurnWithEvents(input) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const events = await load(input.scope);
        const result = validateRetrospectiveCommand(input, events);
        if (!("value" in result)) return result;
        if (result.status === "replayed") return { status: "replayed", value: input.events };
        const turn = input.turn;
        if (turn.employeeId !== input.scope.employeeId || turn.threadId !== input.scope.threadId || turn.subjectKey !== input.scope.subjectKey || input.events.some((event) => event.sourceMessageId !== turn.messageId)) return { status: "forbidden" };
        if (input.events.every((event) => event.action.type === "response_delivery")) {
          await canonical.appendDeliveryEvents({ scope: input.scope, sourceMessageId: turn.messageId, events: input.events });
        } else {
          if (input.events.some((event) => event.action.type === "response_delivery")) return { status: "failed", code: "validation_error" };
          await canonical.appendTurn({ ...turn, retrospectiveEvents: input.events });
        }
        return { status: "applied", value: input.events };
      } catch { return failure(); } finally { release(); }
    },
  };
}
export function createInMemoryWorkRetrospectiveStore(canonical: RetrospectiveCanonicalStore): WorkRetrospectiveStore {
  const snapshots: WorkRetrospectiveEpisode[] = [];
  return createRetrospectiveStore(canonical, { async replace(scope, episodes) {
    for (let index = snapshots.length - 1; index >= 0; index--) if (sameScope(snapshots[index]!, scope)) snapshots.splice(index, 1);
    snapshots.push(...structuredClone(episodes));
  } });
}
