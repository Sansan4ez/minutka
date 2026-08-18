import { randomUUID } from "node:crypto";
import type { Participant } from "../domain/employee.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { EmployeePersonalDataDeletionCounts, ProfileStore } from "./profile-store.js";
import { PersistenceError } from "./persistence-error.js";
import type { ResearchEvidenceRef, ResearchSubject } from "./research-identity-projection.js";

function upsertByEmployeeId<T extends { employeeId: string }>(items: T[], value: T) {
  const index = items.findIndex((item) => item.employeeId === value.employeeId);
  if (index === -1) items.push(value);
  else items[index] = value;
}

const deletionMarkerCounters = new WeakMap<InMemoryWorld, number>();
function worldAuditDeletionMarker(world: InMemoryWorld): void {
  const counter = (deletionMarkerCounters.get(world) ?? 0) + 1;
  deletionMarkerCounters.set(world, counter);
  const occurredAt = world.now();
  world.auditEvents.push({
    id: `anonymous-deletion-${counter}`,
    requestId: `anonymous-deletion-${counter}`,
    type: "employee_data_deleted",
    occurredAt,
    metadata: {},
  });
}

const inviteIndexes = new WeakMap<InMemoryWorld, Map<string, string>>();

function researchSubject(world: InMemoryWorld, participant: Participant): ResearchSubject {
  const evidenceRefs: ResearchEvidenceRef[] = world.messages
    .filter((message) => message.subjectKey === participant.subjectKey)
    .map((message) => ({ kind: "message", id: message.id }));
  return {
    companyId: participant.companyId,
    groupId: participant.groupId,
    subjectKey: participant.subjectKey,
    ...(participant.roleId ? { roleId: participant.roleId } : {}),
    evidenceRefs,
  };
}

function emptyDeletionCounts(): EmployeePersonalDataDeletionCounts {
  return {
    participants: 0,
    profiles: 0,
    consents: 0,
    conversations: 0,
    threadSummaries: 0,
    messages: 0,
    activities: 0,
    insights: 0,
    feedback: 0,
    schedules: 0,
    scheduleFires: 0,
    telegramSessions: 0,
    telegramActionMessages: 0,
    onboardingDrafts: 0,
    pendingActionGroups: 0,
    ideas: 0,
    ideaDeletionConfirmations: 0,
    tasks: 0,
    taskMutationConfirmations: 0,
    contextDocumentConfirmations: 0,
    artifacts: 0,
    artifactContents: 0,
    auditEvents: 0,
    usageRecords: 0,
  };
}

/**
 * Executable-spec store. Raw invite codes stay outside observable world state,
 * while adapters over the same fixture share the private lookup.
 */
export function createInMemoryProfileStore(
  world: InMemoryWorld,
  options: {
    afterDelete?: (employeeId: string) => Promise<Partial<EmployeePersonalDataDeletionCounts> | void>;
    subjectKey?: () => string;
  } = {},
): ProfileStore {
  const employeeByInviteCode = inviteIndexes.get(world) ?? new Map<string, string>();
  inviteIndexes.set(world, employeeByInviteCode);

  return {
    async issueInvite({ employeeId, inviteCode, companyId, groupId, issuedAt }) {
      const existingEmployeeForInvite = employeeByInviteCode.get(inviteCode);
      if (existingEmployeeForInvite) {
        const participant = world.participants.find((candidate) => candidate.employeeId === existingEmployeeForInvite);
        if (!participant) throw new Error("in-memory invite index is inconsistent");
        return {
          participant,
          created: false,
          inviteMatches: existingEmployeeForInvite === employeeId,
        };
      }
      const existingByEmployee = world.participants.find((candidate) => candidate.employeeId === employeeId);
      if (existingByEmployee) return { participant: existingByEmployee, created: false, inviteMatches: false };
      const subjectKey = options.subjectKey?.() ?? randomUUID();
      if (!subjectKey.trim() || world.participants.some((candidate) => candidate.subjectKey === subjectKey)) {
        throw new PersistenceError("persistence_conflict");
      }
      const participant: Participant = {
        employeeId,
        companyId,
        groupId,
        subjectKey,
        status: "invite_issued",
        createdAt: issuedAt,
        updatedAt: issuedAt,
      };
      employeeByInviteCode.set(inviteCode, employeeId);
      world.participants.push(participant);
      return { participant, created: true, inviteMatches: true };
    },
    async openInvite({ inviteCode, openedAt, explanationShownAt }) {
      const employeeId = employeeByInviteCode.get(inviteCode);
      if (!employeeId) return undefined;
      const index = world.participants.findIndex((participant) => participant.employeeId === employeeId);
      if (index === -1) throw new Error("in-memory invite index is inconsistent");
      const participant = world.participants[index];
      if (participant.status !== "invite_issued") return { participant, opened: false };
      const opened: Participant = {
        ...participant,
        status: "invite_opened",
        updatedAt: openedAt,
        ...(explanationShownAt ? { privacyExplanationShownAt: explanationShownAt } : {}),
      };
      world.participants[index] = opened;
      return { participant: opened, opened: true };
    },
    async acceptConsent(consent) {
      const existingIndex = world.consents.findIndex((candidate) => candidate.employeeId === consent.employeeId);
      if (existingIndex !== -1) {
        const existing = world.consents[existingIndex];
        if (existing.privacyVersion === consent.privacyVersion) return { consent: existing, created: false };
        world.consents[existingIndex] = consent;
      } else {
        world.consents.push(consent);
      }
      const participant = world.participants.find((candidate) => candidate.employeeId === consent.employeeId);
      if (participant && participant.status !== "profile_completed") {
        upsertByEmployeeId(world.participants, {
          ...participant,
          status: "consent_accepted",
          updatedAt: consent.acceptedAt,
        });
      }
      return { consent, created: true };
    },
    async recordPrivacyExplanationShown({ employeeId, shownAt }) {
      const participant = world.participants.find((candidate) => candidate.employeeId === employeeId);
      if (!participant) throw new PersistenceError("participant_not_found");
      upsertByEmployeeId(world.participants, {
        ...participant,
        privacyExplanationShownAt: shownAt,
        updatedAt: shownAt,
      });
    },
    async completeProfile({ profile, completedAt, allowUpdate = true, deleteOnboardingDraft = false }) {
      const existing = world.profiles.find((candidate) => candidate.employeeId === profile.employeeId);
      const participant = world.participants.find((candidate) => candidate.employeeId === profile.employeeId);
      if (!participant) throw new PersistenceError("participant_not_found");
      const wasCompleted = Boolean(existing && participant.status === "profile_completed");
      if (wasCompleted && !allowUpdate) {
        if (deleteOnboardingDraft) world.onboardingDrafts = world.onboardingDrafts.filter((draft) => draft.employeeId !== profile.employeeId);
        return { profile: existing!, wasCompleted: true };
      }
      upsertByEmployeeId(world.profiles, profile);
      upsertByEmployeeId(world.participants, {
        ...participant,
        roleId: profile.roleId,
        status: "profile_completed",
        updatedAt: completedAt,
      });
      if (deleteOnboardingDraft) world.onboardingDrafts = world.onboardingDrafts.filter((draft) => draft.employeeId !== profile.employeeId);
      return { profile, wasCompleted };
    },
    async getParticipant(employeeId) {
      return world.participants.find((participant) => participant.employeeId === employeeId);
    },
    async listResearchSubjects({ companyId, groupId }) {
      return world.participants
        .filter((participant) => participant.companyId === companyId && participant.groupId === groupId)
        .map((participant) => researchSubject(world, participant));
    },
    async getResearchSubject({ companyId, groupId, subjectKey }) {
      const participant = world.participants.find((candidate) =>
        candidate.companyId === companyId && candidate.groupId === groupId && candidate.subjectKey === subjectKey);
      return participant ? researchSubject(world, participant) : undefined;
    },
    async listParticipants({ limit, after }) {
      return [...world.participants]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.employeeId.localeCompare(right.employeeId))
        .filter((participant) => !after
          || participant.createdAt > after.createdAt
          || (participant.createdAt === after.createdAt && participant.employeeId > after.employeeId))
        .slice(0, limit);
    },
    async getParticipantByInviteCode(inviteCode) {
      const employeeId = employeeByInviteCode.get(inviteCode);
      return employeeId ? world.participants.find((participant) => participant.employeeId === employeeId) : undefined;
    },
    async getConsent(employeeId) {
      return world.consents.find((consent) => consent.employeeId === employeeId);
    },
    async getProfile(employeeId) {
      return world.profiles.find((profile) => profile.employeeId === employeeId);
    },
    async deleteEmployeePersonalData(employeeId) {
      const before = Object.fromEntries(
        (["messages", "insights", "feedback", "profiles", "consents", "participants"] as const)
          .map((key) => [key, world[key].length]),
      ) as Record<"messages" | "insights" | "feedback" | "profiles" | "consents" | "participants", number>;
      for (const key of ["messages", "insights", "feedback", "profiles", "consents", "participants"] as const) {
        world[key] = world[key].filter((record) => record.employeeId !== employeeId) as never;
      }
      for (const [inviteCode, indexedEmployeeId] of employeeByInviteCode) {
        if (indexedEmployeeId === employeeId) employeeByInviteCode.delete(inviteCode);
      }
      const deletedAuditEvents = world.auditEvents.filter((record) => record.employeeId === employeeId).length;
      world.auditEvents = world.auditEvents.filter((record) => record.employeeId !== employeeId);
      world.events = world.events.filter((record) => !("employeeId" in record && record.employeeId === employeeId));
      const additional = await options.afterDelete?.(employeeId);
      worldAuditDeletionMarker(world);
      return {
        ...emptyDeletionCounts(),
        participants: before.participants - world.participants.length,
        profiles: before.profiles - world.profiles.length,
        consents: before.consents - world.consents.length,
        messages: before.messages - world.messages.length,
        insights: before.insights - world.insights.length,
        feedback: before.feedback - world.feedback.length,
        auditEvents: deletedAuditEvents,
        ...additional,
      };
    },
  };
}
