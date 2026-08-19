import type { Consent, Participant, UserProfile } from "../domain/employee.js";
import type { ParticipantPageCursor } from "./participant-pagination.js";
import type { ResearchSubject } from "./research-identity-projection.js";

export type IssueInviteResult = { participant: Participant; created: boolean; inviteMatches: boolean };
export type OpenInviteResult = { participant: Participant; opened: boolean };
export type ClaimConsentResult = { consent: Consent; created: boolean };
/** `wasCompleted` means the participant was finalized before this call. */
export type CompleteProfileResult = { profile: UserProfile; wasCompleted: boolean };
export type EmployeePersonalDataDeletionCounts = {
  participants: number;
  profiles: number;
  consents: number;
  conversations: number;
  threadSummaries: number;
  messages: number;
  activities: number;
  insights: number;
  feedback: number;
  schedules: number;
  scheduleFires: number;
  telegramSessions: number;
  telegramActionMessages: number;
  onboardingDrafts: number;
  pendingActionGroups: number;
  ideas: number;
  ideaDeletionConfirmations: number;
  tasks: number;
  taskMutationConfirmations: number;
  contextDocumentConfirmations: number;
  artifacts: number;
  artifactContents: number;
  auditEvents: number;
  usageRecords: number;
};

/** Owner of participant, consent and profile state. Raw invite codes are inputs only. */
export type ProfileStore = {
  issueInvite(input: {
    employeeId: string;
    inviteCode: string;
    companyId: string;
    groupId: string;
    issuedAt: string;
  }): Promise<IssueInviteResult>;
  openInvite(input: {
    inviteCode: string;
    openedAt: string;
    explanationShownAt?: string;
  }): Promise<OpenInviteResult | undefined>;
  acceptConsent(consent: Consent): Promise<ClaimConsentResult>;
  recordPrivacyExplanationShown(input: {
    employeeId: string;
    shownAt: string;
  }): Promise<void>;
  completeProfile(input: {
    profile: UserProfile;
    completedAt: string;
    /** Direct completion may update an existing profile; draft confirmation may not. */
    allowUpdate?: boolean;
    /** Atomically removes temporary onboarding data when profile completion commits. */
    deleteOnboardingDraft?: boolean;
  }): Promise<CompleteProfileResult>;
  getParticipant(employeeId: string): Promise<Participant | undefined>;
  /** Records only the local calendar date of an inbound employee touch. */
  recordParticipantTouch(input: { employeeId: string; touchedOn: string }): Promise<void>;
  /** Tenant-scoped research projection without employee or transport identity. */
  listResearchSubjects(input: { companyId: string; groupId: string }): Promise<ResearchSubject[]>;
  /** Exact tenant scope is mandatory; subject keys are lookup handles, not credentials. */
  getResearchSubject(input: { companyId: string; groupId: string; subjectKey: string }): Promise<ResearchSubject | undefined>;
  /** Cursor-paginated operator inventory; callers must not project private profile or Telegram data. */
  listParticipants(input: { companyId: string; groupId: string; limit: number; after?: ParticipantPageCursor }): Promise<Participant[]>;
  /** Private lookup used only by the atomic Telegram invite-redemption adapter. */
  getParticipantByInviteCode(inviteCode: string): Promise<Participant | undefined>;
  getConsent(employeeId: string): Promise<Consent | undefined>;
  getProfile(employeeId: string): Promise<UserProfile | undefined>;
  deleteEmployeePersonalData(employeeId: string): Promise<EmployeePersonalDataDeletionCounts>;
};
