import type { Consent, Participant, UserProfile } from "../domain/employee.js";

export type ProfileStore = {
  saveParticipant(participant: Participant): Promise<void>;
  getParticipant(employeeId: string): Promise<Participant | undefined>;
  getParticipantByInvite(inviteCode: string): Promise<Participant | undefined>;

  saveConsent(consent: Consent): Promise<void>;
  getConsent(employeeId: string): Promise<Consent | undefined>;

  saveProfile(profile: UserProfile): Promise<void>;
  getProfile(employeeId: string): Promise<UserProfile | undefined>;
};
