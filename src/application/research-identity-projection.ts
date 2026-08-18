import type { ProfileStore } from "./profile-store.js";

export type ResearchEvidenceRef =
  | { kind: "message"; id: string }
  | { kind: "activity"; id: string }
  | { kind: "trace"; id: string };

/** Research-safe participant identity. It deliberately excludes employee and transport identity. */
export type ResearchSubject = {
  companyId: string;
  groupId: string;
  subjectKey: string;
  roleId?: string;
  evidenceRefs: ResearchEvidenceRef[];
};

export type ResearchIdentityProjection = {
  listSubjects(input: { companyId: string; groupId: string }): Promise<ResearchSubject[]>;
  getSubject(input: { companyId: string; groupId: string; subjectKey: string }): Promise<ResearchSubject | undefined>;
};

export function createResearchIdentityProjection(
  participants: Pick<ProfileStore, "listResearchSubjects" | "getResearchSubject">,
): ResearchIdentityProjection {
  return {
    listSubjects: (input) => participants.listResearchSubjects(input),
    getSubject: (input) => participants.getResearchSubject(input),
  };
}
