import type { AiLevel, Persona, ResponseLengthPreference, UserProfile } from "../domain/employee.js";
import type { CompanyRole, TenantDirectoryStore } from "./tenant-directory-store.js";
import type { ProfileStore } from "./profile-store.js";
import { PersistenceError } from "./persistence-error.js";
import {
  maximumProgramGoalCharacters,
  maximumTypicalTaskCharacters,
  maximumTypicalTasks,
  normalizeProgramGoal,
  normalizeTypicalTasks,
} from "./personal-profile-context.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";

export const personalContextPatchFields = [
  "preferredName",
  "persona",
  "responseLength",
  "timezone",
  "role",
  "typicalTasks",
  "aiLevel",
  "programGoal",
] as const;

export type PersonalContextPatchField = typeof personalContextPatchFields[number];

export type PersonalContextPatch = {
  preferredName?: string;
  persona?: Persona;
  responseLength?: ResponseLengthPreference;
  timezone?: string;
  role?: string;
  typicalTasks?: string[];
  aiLevel?: AiLevel;
  programGoal?: string;
};

export type PersonalContextView = {
  confirmedProfile: {
    preferredName: string;
    persona: Persona;
    responseLength: ResponseLengthPreference;
    timezone: string;
    exactRole: string;
    selfDescription?: string;
    typicalTasks?: string[];
    aiLevel?: AiLevel;
    programGoal?: string;
  };
  observations: {
    status: "none_confirmed";
    items: [];
    note: string;
  };
  editableFields: PersonalContextPatchField[];
};

export type PersonalContextUpdateResult = {
  context: PersonalContextView;
  changedFields: PersonalContextPatchField[];
};

const maximumPreferredNameCharacters = 128;
const maximumRoleDescriptionCharacters = 2_000;

function boundedRequiredText(value: string, maximumCharacters: number, field: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error(`${field} must be non-empty`);
  if (Array.from(normalized).length > maximumCharacters) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizePatch(input: PersonalContextPatch): PersonalContextPatch {
  if (!personalContextPatchFields.some((field) => input[field] !== undefined)) throw new Error("personal context patch must not be empty");
  const timezone = input.timezone === undefined ? undefined : normalizeIanaTimezone(input.timezone);
  if (input.timezone !== undefined && !timezone) throw new Error("timezone must be a valid IANA timezone");
  const typicalTasks = input.typicalTasks === undefined ? undefined : normalizeTypicalTasks(input.typicalTasks);
  if (input.typicalTasks !== undefined && !typicalTasks) throw new Error("typicalTasks must contain at least one non-empty task");
  const programGoal = input.programGoal === undefined ? undefined : normalizeProgramGoal(input.programGoal);
  if (input.programGoal !== undefined && !programGoal) throw new Error("programGoal must be non-empty");
  return {
    ...(input.preferredName === undefined ? {} : { preferredName: boundedRequiredText(input.preferredName, maximumPreferredNameCharacters, "preferredName") }),
    ...(input.persona === undefined ? {} : { persona: input.persona }),
    ...(input.responseLength === undefined ? {} : { responseLength: input.responseLength }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(input.role === undefined ? {} : { role: boundedRequiredText(input.role, maximumRoleDescriptionCharacters, "role") }),
    ...(typicalTasks === undefined ? {} : { typicalTasks }),
    ...(input.aiLevel === undefined ? {} : { aiLevel: input.aiLevel }),
    ...(programGoal === undefined ? {} : { programGoal }),
  };
}

export function applyPersonalContextPatch(
  profile: UserProfile,
  input: PersonalContextPatch,
  updatedAt: string,
  options: { replaceTypicalTasks?: boolean } = {},
): { profile: UserProfile; changedFields: PersonalContextPatchField[] } {
  const patch = normalizePatch(input);
  const typicalTasks = patch.typicalTasks
    ? options.replaceTypicalTasks
      ? patch.typicalTasks
      : normalizeTypicalTasks([...(profile.typicalTasks ?? []), ...patch.typicalTasks])
    : profile.typicalTasks;
  const next: UserProfile = {
    ...profile,
    ...patch,
    ...(typicalTasks ? { typicalTasks: [...typicalTasks] } : {}),
    updatedAt,
  };
  const changedFields = personalContextPatchFields.filter((field) => JSON.stringify(profile[field]) !== JSON.stringify(next[field]));
  return { profile: changedFields.length > 0 ? next : profile, changedFields };
}

function contextView(profile: UserProfile, role: CompanyRole): PersonalContextView {
  return {
    confirmedProfile: {
      preferredName: profile.preferredName,
      persona: profile.persona,
      responseLength: profile.responseLength,
      timezone: profile.timezone,
      exactRole: role.name,
      ...(profile.role ? { selfDescription: profile.role } : {}),
      ...(profile.typicalTasks?.length ? { typicalTasks: [...profile.typicalTasks] } : {}),
      ...(profile.aiLevel ? { aiLevel: profile.aiLevel } : {}),
      ...(profile.programGoal ? { programGoal: profile.programGoal } : {}),
    },
    observations: {
      status: "none_confirmed",
      items: [],
      note: "Подтверждённых наблюдаемых паттернов пока нет; непроверенные выводы не показываются как факты и не сохраняются автоматически.",
    },
    editableFields: [...personalContextPatchFields],
  };
}

/** Owner-bound read and patch use-cases for the narrow personal-context surface. */
export class PersonalContextReviewService {
  constructor(
    private readonly profiles: Pick<ProfileStore, "getProfile" | "updatePersonalContext">,
    private readonly tenantDirectory: Pick<TenantDirectoryStore, "getRole">,
    private readonly clock: { now(): string },
  ) {}

  async get(employeeId: string): Promise<PersonalContextView> {
    const profile = await this.profiles.getProfile(employeeId);
    if (!profile) throw new PersistenceError("profile_not_found");
    const role = await this.tenantDirectory.getRole({ companyId: profile.companyId, roleId: profile.roleId });
    if (!role) throw new PersistenceError("persistence_conflict");
    return contextView(profile, role);
  }

  async update(employeeId: string, patch: PersonalContextPatch): Promise<PersonalContextUpdateResult> {
    const result = await this.profiles.updatePersonalContext({ employeeId, patch, updatedAt: this.clock.now(), replaceTypicalTasks: true });
    const role = await this.tenantDirectory.getRole({ companyId: result.profile.companyId, roleId: result.profile.roleId });
    if (!role) throw new PersistenceError("persistence_conflict");
    return { context: contextView(result.profile, role), changedFields: result.changedFields as PersonalContextPatchField[] };
  }
}

export const personalContextLimits = {
  maximumTypicalTasks,
  maximumTypicalTaskCharacters,
  maximumProgramGoalCharacters,
  maximumPreferredNameCharacters,
  maximumRoleDescriptionCharacters,
} as const;
