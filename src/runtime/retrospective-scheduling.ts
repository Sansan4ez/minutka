import { createRetrospectiveTouchPolicy } from "../application/retrospective-touch-policy.js";
import type { ProfileStore } from "../application/profile-store.js";
import type { WorkRetrospectivePolicyStore } from "../application/work-retrospective-policy.js";
import type { WorkRetrospectiveUseCases } from "../application/work-retrospective-store.js";
import type { createRetrospectiveDelivery } from "../application/retrospective-delivery.js";
import type { TelegramSessionStore } from "../telegram/telegram-session-store.js";

/** Shared trusted composition: identity and thread never come from a model prompt. */
export function createRuntimeRetrospectiveTouchPolicy(input: {
  profiles: Pick<ProfileStore, "getParticipant" | "getProfile">;
  sessions: Pick<TelegramSessionStore, "getDeliveryByEmployee">;
  policies: WorkRetrospectivePolicyStore;
  episodes: Pick<WorkRetrospectiveUseCases, "readEpisodes">;
  delivery: Pick<ReturnType<typeof createRetrospectiveDelivery>, "readDeliveries">;
  now(): string;
}) {
  return createRetrospectiveTouchPolicy({
    policies: input.policies, episodes: input.episodes, now: input.now,
    readDeliveries: (request) => input.delivery.readDeliveries(request),
    async resolveOwner(fire) {
      const participant = await input.profiles.getParticipant(fire.userId);
      const profile = await input.profiles.getProfile(fire.userId);
      const session = await input.sessions.getDeliveryByEmployee(fire.userId);
      if (!participant || !profile || !session || participant.status !== "profile_completed"
        || profile.companyId !== participant.companyId || profile.groupId !== participant.groupId) return undefined;
      return { scope: { employeeId: fire.userId, companyId: participant.companyId,
        groupId: participant.groupId, subjectKey: participant.subjectKey, threadId: session.threadId }, timezone: profile.timezone };
    },
  });
}
