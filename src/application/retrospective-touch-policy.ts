import type { RetrospectiveScope, WorkRetrospectiveEvent } from "../domain/work-retrospective.js";
import type { ScheduledActionFire } from "./scheduler-service.js";
import type { WorkRetrospectiveUseCases } from "./work-retrospective-store.js";
import { resolveWorkRetrospectivePolicy, type WorkRetrospectivePolicyStore } from "./work-retrospective-policy.js";

export type RetrospectiveTouchProcess = "evening_reflection" | "weekly_summary" | "final_report";
/** Process and fire identity come from trusted scheduled-turn provenance, never model text.
 * Evidence must be read through a scoped application use-case, not directly from an adapter.
 */
export type RetrospectiveTouchDelivery = {
  processId: RetrospectiveTouchProcess;
  scheduleId: string;
  scheduledFor: string;
  event: WorkRetrospectiveEvent;
};
export type RetrospectiveTouchContext = {
  localDate: string;
  mode: "invite" | "continue";
  episodeId?: string;
  /** Runner must retain factual collection/summary and must not start another questionnaire. */
  preservePendingQuestion: boolean;
};
export type RetrospectiveTouchDecision =
  | { action: "run"; context?: RetrospectiveTouchContext }
  | { action: "suppress"; reason: "already_delivered" | "replaced_by_summary" };
export type ScheduledTouchPolicy = (fire: ScheduledActionFire) => Promise<RetrospectiveTouchDecision>;

export function retrospectiveLocalDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Optional scheduler DI: T4b resolves participant scope and connects the delivery reader.
 * Does not write delivery or question budgets: only transport-success canonical events count.
 */
export function createRetrospectiveTouchPolicy(dependencies: {
  policies: WorkRetrospectivePolicyStore;
  episodes: Pick<WorkRetrospectiveUseCases, "readEpisodes">;
  resolveOwner(fire: ScheduledActionFire): Promise<{ scope: RetrospectiveScope; timezone: string } | undefined>;
  readDeliveries(request: { scope: RetrospectiveScope; localDate: string }): Promise<RetrospectiveTouchDelivery[]>;
  now(): string;
}): ScheduledTouchPolicy {
  return async (fire) => {
    if (fire.kind !== "process" || !isTouch(fire.processId)) return { action: "run" };
    const owner = await dependencies.resolveOwner(fire);
    if (!owner || owner.scope.employeeId !== fire.userId) return { action: "run" };
    const now = dependencies.now();
    // Production availability is directory-derived; legacy policies remain fixture DI.
    const availability = dependencies.policies.availability
      ? await dependencies.policies.availability(owner.scope) : undefined;
    if (dependencies.policies.availability) {
      if (!availability || availability.companyId !== owner.scope.companyId || availability.groupId !== owner.scope.groupId
        || now < availability.period.start || now >= availability.period.end) return { action: "run" };
    } else if (!(await resolveWorkRetrospectivePolicy(dependencies.policies, owner.scope, now)).enabled) return { action: "run" };
    const localDate = retrospectiveLocalDate(now, owner.timezone);
    const deliveries = (await dependencies.readDeliveries({ scope: owner.scope, localDate })).filter(({ event }) =>
      sameScope(event, owner.scope) && event.action.type === "response_delivery"
      && event.action.status === "delivered" && event.action.localDate === localDate
      && retrospectiveLocalDate(event.timestamp, owner.timezone) === localDate);
    if (deliveries.some((delivery) => delivery.scheduleId === fire.scheduleId && delivery.scheduledFor === fire.scheduledFor)) {
      return { action: "suppress", reason: "already_delivered" };
    }
    if (fire.processId === "evening_reflection" && deliveries.some(({ processId }) => processId === "weekly_summary" || processId === "final_report")) {
      return { action: "suppress", reason: "replaced_by_summary" };
    }
    const episodes = await dependencies.episodes.readEpisodes({ scope: owner.scope, limit: 100 });
    if (!("value" in episodes)) throw new Error("Retrospective touch context unavailable");
    const active = episodes.value.find((episode) => sameScope(episode, owner.scope) && episode.status === "active");
    const continuing = Boolean(active || deliveries.length);
    return { action: "run", context: {
      localDate, mode: continuing ? "continue" : "invite",
      ...(active || deliveries.length ? { episodeId: active?.episodeId ?? deliveries.at(-1)!.event.episodeId } : {}),
      preservePendingQuestion: Boolean(active?.pendingQuestion),
    } };
  };
}
function isTouch(id: string): id is RetrospectiveTouchProcess {
  return id === "evening_reflection" || id === "weekly_summary" || id === "final_report";
}
function sameScope(value: RetrospectiveScope, scope: RetrospectiveScope): boolean {
  return value.employeeId === scope.employeeId && value.companyId === scope.companyId
    && value.groupId === scope.groupId && value.subjectKey === scope.subjectKey && value.threadId === scope.threadId;
}
