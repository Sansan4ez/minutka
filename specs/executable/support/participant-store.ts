import type { Participant } from "../../../src/domain/employee.js";
import type { ProfileStore } from "../../../src/application/profile-store.js";

/** Minimal participant lookup for AssistantService specs that do not exercise onboarding. */
export function createSpecParticipantStore(
  now: () => string = () => "2026-07-15T09:00:00.000Z",
): Pick<ProfileStore, "getParticipant" | "recordParticipantTouch"> {
  const participants = new Map<string, Participant>();
  let subjectSequence = 0;

  const getParticipant = async (employeeId: string): Promise<Participant> => {
    const existing = participants.get(employeeId);
    if (existing) return existing;
    subjectSequence += 1;
    const timestamp = now();
    const participant: Participant = {
      employeeId,
      companyId: "default_company",
      groupId: "default_group",
      subjectKey: `00000000-0000-4000-8000-${String(subjectSequence).padStart(12, "0")}`,
      roleId: "default_role",
      status: "profile_completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    participants.set(employeeId, participant);
    return participant;
  };
  return {
    getParticipant,
    async recordParticipantTouch({ employeeId, touchedOn }) {
      participants.set(employeeId, { ...(await getParticipant(employeeId)), lastTouchOn: touchedOn });
    },
  };
}
