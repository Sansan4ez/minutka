import type { Consent, Participant, UserProfile } from "../domain/employee.js";

export type ClaimParticipantByInviteResult = {
  participant: Participant;
  created: boolean;
};

export type ProfileStore = {
  saveParticipant(participant: Participant): Promise<void>;
  /**
   * Atomically creates this invite's participant when absent, otherwise returns
   * its existing participant. Persistent adapters must enforce inviteCode
   * uniqueness in the same storage operation.
   */
  claimParticipantByInvite(participant: Participant): Promise<ClaimParticipantByInviteResult>;
  getParticipant(employeeId: string): Promise<Participant | undefined>;
  getParticipantByInvite(inviteCode: string): Promise<Participant | undefined>;

  saveConsent(consent: Consent): Promise<void>;
  getConsent(employeeId: string): Promise<Consent | undefined>;

  saveProfile(profile: UserProfile): Promise<void>;
  getProfile(employeeId: string): Promise<UserProfile | undefined>;
};
