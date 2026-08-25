import type { ActivityCollectionStore, PersonalActivityRecord } from "./activity-collection.js";
import type {
  ActivityCorrectionCommand,
  ActivityMutationStore,
  ActivityRevisionRecord,
  ActivitySupersessionCommand,
} from "./activity-correction.js";
import { PersistenceError } from "./persistence-error.js";
import { createTenantSubjectScopeIndex, type TenantSubjectScopeIndex } from "./tenant-subject-scope.js";
import type { OwnActivityReadStore } from "./own-activity-window.js";
import type { RecentOwnActivityReadStore } from "./recent-own-activities.js";

export type InMemoryActivityCollectionState = {
  activities: PersonalActivityRecord[];
};

export function createInMemoryActivityCollectionState(): InMemoryActivityCollectionState {
  return { activities: [] };
}

export function createInMemoryActivityCollectionStore(
  state: InMemoryActivityCollectionState,
  options: { failWrite?: () => boolean; tenantScope?: TenantSubjectScopeIndex } = {},
): ActivityCollectionStore {
  const tenantScope = options.tenantScope ?? createTenantSubjectScopeIndex();
  return {
    async saveActivity(activity) {
      const canonical = withActivityMetadata(structuredClone(activity));
      if (options.failWrite?.()) throw new Error("canonical activity write failed");
      tenantScope.bindSubject(canonical);
      tenantScope.bindOwner(canonical.employeeId, canonical);
      state.activities.push(canonical);
    },
    async getActivityById(activityId) {
      const activity = state.activities.find((candidate) => candidate.activityId === activityId);
      return activity ? structuredClone(activity) : undefined;
    },
  };
}

/** Owner-and-tenant-scoped recent read for an explicit correction lookup. */
export function createInMemoryRecentOwnActivityReadStore(
  state: InMemoryActivityCollectionState,
): RecentOwnActivityReadStore {
  return {
    async listRecentOwnActivities({ employeeId, companyId, groupId, recordedAfter, recordedBefore, limit }) {
      return state.activities
        .filter((activity) => activity.employeeId === employeeId
          && activity.companyId === companyId
          && activity.groupId === groupId
          && (activity.status ?? "active") === "active"
          && activity.recordedAt >= recordedAfter
          && activity.recordedAt <= recordedBefore)
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)
          || right.activityId.localeCompare(left.activityId))
        .slice(0, limit)
        .map((activity) => structuredClone(activity));
    },
  };
}

/** Owner-scoped read side of the same canonical activity state. */
export function createInMemoryOwnActivityReadStore(
  state: InMemoryActivityCollectionState,
): OwnActivityReadStore {
  return {
    async listOwnActivities({ employeeId, fromDate, toDate }) {
      return state.activities
        .filter((activity) => activity.employeeId === employeeId
          && (activity.status ?? "active") === "active"
          && activity.activityDate >= fromDate
          && activity.activityDate <= toDate)
        .map((activity) => ({
          employeeId: activity.employeeId,
          ...(activity.taskCategory === undefined ? {} : { taskCategory: activity.taskCategory }),
          ...(activity.routinePattern === undefined ? {} : { routinePattern: activity.routinePattern }),
          ...(activity.automationCandidate === undefined ? {} : { automationCandidate: activity.automationCandidate }),
          ...(activity.energyStressMarker === undefined ? {} : { energyStressMarker: activity.energyStressMarker }),
          ...(activity.durationBucket === undefined ? {} : { durationBucket: activity.durationBucket }),
          ...(activity.system === undefined ? {} : { system: activity.system }),
          activityDate: activity.activityDate,
        }));
    },
  };
}

/** Owner-and-tenant-bound local repair over the canonical in-memory rows. */
export function createInMemoryActivityMutationStore(
  state: InMemoryActivityCollectionState,
): ActivityMutationStore {
  return {
    async correctRecentActivity(command) {
      const current = withActivityMetadata(findRecentActivity(state, command));
      const intended = correctedFacets(current, command);
      if (isCorrectionReplay(current, command, intended)) return structuredClone(current);
      requireActiveRevision(current, command.expectedRevision);

      applyFacets(current, intended);
      current.revision = command.expectedRevision + 1;
      current.lastCorrectionMessageId = command.sourceMessageId;
      current.updatedAt = command.changedAt;
      current.revisions = [
        ...(current.revisions ?? [initialRevision(current)]),
        revisionSnapshot(current, "corrected", command.changedAt, command.sourceMessageId),
      ];
      replaceActivity(state, current);
      return structuredClone(current);
    },
    async supersedeRecentActivity(command) {
      const target = withActivityMetadata(findRecentActivity(state, command));
      if (isSupersessionReplay(target, command)) return structuredClone(target);
      const replacement = withActivityMetadata(findRecentActivity(state, {
        ...command,
        handle: command.replacementHandle,
      }));
      requireActiveRevision(target, command.expectedRevision);
      requireActiveRevision(replacement, command.replacementExpectedRevision);

      target.status = "superseded";
      target.supersededByActivityId = replacement.activityId;
      target.revision = command.expectedRevision + 1;
      target.lastCorrectionMessageId = command.sourceMessageId;
      target.updatedAt = command.changedAt;
      target.revisions = [
        ...(target.revisions ?? [initialRevision(target)]),
        revisionSnapshot(target, "superseded", command.changedAt, command.sourceMessageId),
      ];
      replaceActivity(state, target);
      return structuredClone(target);
    },
  };
}

function findRecentActivity(
  state: InMemoryActivityCollectionState,
  command: Pick<ActivityCorrectionCommand, "handle" | "employeeId" | "companyId" | "groupId" | "recordedAfter" | "recordedBefore">,
): PersonalActivityRecord {
  const activity = state.activities.find((candidate) => candidate.activityId === command.handle
    && candidate.employeeId === command.employeeId
    && candidate.companyId === command.companyId
    && candidate.groupId === command.groupId
    && candidate.recordedAt >= command.recordedAfter
    && candidate.recordedAt <= command.recordedBefore);
  if (!activity) throw new PersistenceError("persistence_conflict");
  return activity;
}

function withActivityMetadata(activity: PersonalActivityRecord): PersonalActivityRecord {
  const revision = activity.revision ?? 1;
  const status = activity.status ?? "active";
  return {
    ...activity,
    revision,
    status,
    updatedAt: activity.updatedAt ?? activity.recordedAt,
    revisions: activity.revisions ?? [initialRevision({ ...activity, revision, status })],
  };
}

function initialRevision(activity: PersonalActivityRecord): ActivityRevisionRecord {
  return revisionSnapshot(activity, "created", activity.recordedAt, activity.sourceMessageId);
}

function revisionSnapshot(
  activity: PersonalActivityRecord,
  operation: ActivityRevisionRecord["operation"],
  changedAt: string,
  sourceMessageId?: string,
): ActivityRevisionRecord {
  return {
    revision: activity.revision ?? 1,
    operation,
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
    ...(activity.taskCategory === undefined ? {} : { taskCategory: activity.taskCategory }),
    ...(activity.routinePattern === undefined ? {} : { routinePattern: activity.routinePattern }),
    ...(activity.automationCandidate === undefined ? {} : { automationCandidate: activity.automationCandidate }),
    ...(activity.energyStressMarker === undefined ? {} : { energyStressMarker: activity.energyStressMarker }),
    ...(activity.durationBucket === undefined ? {} : { durationBucket: activity.durationBucket }),
    ...(activity.system === undefined ? {} : { system: activity.system }),
    status: activity.status ?? "active",
    ...(activity.supersededByActivityId === undefined ? {} : { supersededByActivityId: activity.supersededByActivityId }),
    changedAt,
  };
}

function correctedFacets(activity: PersonalActivityRecord, command: ActivityCorrectionCommand): PersonalActivityRecord {
  const base = command.mode === "patch" ? activity : clearFacets(activity);
  return {
    ...base,
    ...(command.taskCategory === undefined ? {} : { taskCategory: command.taskCategory }),
    ...(command.routinePattern === undefined ? {} : { routinePattern: command.routinePattern }),
    ...(command.automationCandidate === undefined ? {} : { automationCandidate: command.automationCandidate }),
    ...(command.energyStressMarker === undefined ? {} : { energyStressMarker: command.energyStressMarker }),
    ...(command.durationBucket === undefined ? {} : { durationBucket: command.durationBucket }),
    ...(command.system === undefined ? {} : { system: command.system }),
  };
}

function clearFacets(activity: PersonalActivityRecord): PersonalActivityRecord {
  const result = { ...activity };
  delete result.taskCategory;
  delete result.routinePattern;
  delete result.automationCandidate;
  delete result.energyStressMarker;
  delete result.durationBucket;
  delete result.system;
  return result;
}

function applyFacets(target: PersonalActivityRecord, source: PersonalActivityRecord): void {
  for (const facet of ["taskCategory", "routinePattern", "automationCandidate", "energyStressMarker", "durationBucket", "system"] as const) {
    if (source[facet] === undefined) delete target[facet];
    else Object.assign(target, { [facet]: source[facet] });
  }
}

function requireActiveRevision(activity: PersonalActivityRecord, expectedRevision: number): void {
  if ((activity.status ?? "active") !== "active" || (activity.revision ?? 1) !== expectedRevision) {
    throw new PersistenceError("persistence_conflict");
  }
}

function isCorrectionReplay(
  current: PersonalActivityRecord,
  command: ActivityCorrectionCommand,
  intended: PersonalActivityRecord,
): boolean {
  return current.lastCorrectionMessageId === command.sourceMessageId
    && (current.revision ?? 1) === command.expectedRevision + 1
    && sameFacets(current, intended)
    && (current.status ?? "active") === "active";
}

function isSupersessionReplay(current: PersonalActivityRecord, command: ActivitySupersessionCommand): boolean {
  return current.lastCorrectionMessageId === command.sourceMessageId
    && (current.revision ?? 1) === command.expectedRevision + 1
    && current.status === "superseded"
    && current.supersededByActivityId === command.replacementHandle;
}

function sameFacets(left: PersonalActivityRecord, right: PersonalActivityRecord): boolean {
  return left.taskCategory === right.taskCategory
    && left.routinePattern === right.routinePattern
    && left.automationCandidate === right.automationCandidate
    && left.energyStressMarker === right.energyStressMarker
    && left.durationBucket === right.durationBucket
    && left.system === right.system;
}

function replaceActivity(state: InMemoryActivityCollectionState, activity: PersonalActivityRecord): void {
  const index = state.activities.findIndex((candidate) => candidate.activityId === activity.activityId);
  if (index < 0) throw new PersistenceError("persistence_conflict");
  state.activities[index] = structuredClone(activity);
}
