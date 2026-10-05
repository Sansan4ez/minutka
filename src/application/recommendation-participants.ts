import type { ProfileStore } from "./profile-store.js";
import type { ConversationStore } from "./conversation-store.js";
import type { ResearchEvidenceScope } from "./research-evidence-read.js";
import type { RetrospectiveScope } from "../domain/work-retrospective.js";
import type { ParticipantPageCursor } from "./participant-pagination.js";

/** Private discovery stays in trusted application code; neither IDs nor pagination reach the model. */
export function createRecommendationParticipants(profiles: Pick<ProfileStore, "listParticipants">, conversations: Pick<ConversationStore, "listOwnerThreads">) {
  return async (scope: ResearchEvidenceScope): Promise<RetrospectiveScope[]> => {
    const scopes: RetrospectiveScope[] = [];
    const seen = new Set<string>();
    let after: ParticipantPageCursor | undefined;
    for (;;) {
      const page = await profiles.listParticipants({ ...scope, limit: 100, ...(after ? { after } : {}) });
      for (const participant of page) {
        if (participant.companyId !== scope.companyId || participant.groupId !== scope.groupId || seen.has(participant.employeeId)) throw new Error("participant_discovery_incomplete");
        seen.add(participant.employeeId);
        for (const threadId of await conversations.listOwnerThreads(participant)) {
          scopes.push({ ...scope, employeeId: participant.employeeId, subjectKey: participant.subjectKey, threadId });
        }
      }
      if (page.length < 100) return scopes;
      const last = page.at(-1)!;
      after = { createdAt: last.createdAt, employeeId: last.employeeId };
    }
  };
}
