import type { AiLevel, UserProfile } from "../domain/employee.js";

export const maximumTypicalTasks = 7;
export const maximumTypicalTaskCharacters = 160;
export const maximumProgramGoalCharacters = 500;

export type PersonalProfileContextPatch = {
  typicalTasks?: string[];
  aiLevel?: AiLevel;
  programGoal?: string;
};

export type PersonalProfileContextUpdateResult = {
  profile: UserProfile;
  changedFields: Array<keyof PersonalProfileContextPatch>;
};

function boundedText(value: string, maximumCharacters: number): string | undefined {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, maximumCharacters).join("");
}

export function normalizeTypicalTasks(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const seen = new Set<string>();
  const tasks: string[] = [];
  for (const value of values) {
    const task = boundedText(value, maximumTypicalTaskCharacters);
    if (!task) continue;
    const key = task.toLocaleLowerCase("ru");
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(task);
    if (tasks.length === maximumTypicalTasks) break;
  }
  return tasks.length > 0 ? tasks : undefined;
}

export function normalizeProgramGoal(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedText(value, maximumProgramGoalCharacters);
}

export function normalizePersonalProfileContextPatch(input: PersonalProfileContextPatch): PersonalProfileContextPatch {
  const typicalTasks = normalizeTypicalTasks(input.typicalTasks);
  const programGoal = normalizeProgramGoal(input.programGoal);
  return {
    ...(typicalTasks ? { typicalTasks } : {}),
    ...(input.aiLevel ? { aiLevel: input.aiLevel } : {}),
    ...(programGoal ? { programGoal } : {}),
  };
}

/** Adds newly stated tasks and replaces scalar fields explicitly stated by the employee. */
export function applyPersonalProfileContextPatch(
  profile: UserProfile,
  input: PersonalProfileContextPatch,
  updatedAt: string,
): PersonalProfileContextUpdateResult {
  if (input.typicalTasks === undefined && input.aiLevel === undefined && input.programGoal === undefined) throw new Error("personal profile context patch must not be empty");
  const patch = normalizePersonalProfileContextPatch(input);
  const typicalTasks = patch.typicalTasks
    ? normalizeTypicalTasks([...(profile.typicalTasks ?? []), ...patch.typicalTasks])
    : profile.typicalTasks;
  const next: UserProfile = {
    ...profile,
    ...(typicalTasks ? { typicalTasks } : {}),
    ...(patch.aiLevel ? { aiLevel: patch.aiLevel } : {}),
    ...(patch.programGoal ? { programGoal: patch.programGoal } : {}),
    updatedAt,
  };
  const changedFields = (["typicalTasks", "aiLevel", "programGoal"] as const)
    .filter((field) => JSON.stringify(profile[field]) !== JSON.stringify(next[field]));
  return { profile: changedFields.length > 0 ? next : profile, changedFields: [...changedFields] };
}
