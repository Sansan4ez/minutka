import type { AiLevel, Persona } from "../domain/employee.js";
import type { OnboardingDraft, OnboardingField, OnboardingProfilePatch } from "./onboarding-types.js";

export type OnboardingProfileExtractor = (input: {
  text: string;
  currentDraft: OnboardingDraft;
}) => Promise<OnboardingProfilePatch>;

/**
 * Conservative, dependency-free extraction used both as the reliable fallback
 * and by executable specs. It only emits values that have an explicit signal.
 */
export function extractDeterministicOnboardingPatch(input: {
  text: string;
  currentDraft: OnboardingDraft;
}): OnboardingProfilePatch {
  const text = input.text.trim();
  const normalized = normalize(text);
  const patch: OnboardingProfilePatch = { ambiguousFields: [] };
  const pipe = text.split("|").map((part) => part.trim());
  if (pipe.length === 4 && pipe.every(Boolean)) {
    patch.role = pipe[0];
    patch.typicalTasks = tasks(pipe[1]);
    patch.persona = persona(pipe[2]);
    patch.aiLevel = aiLevel(pipe[3]);
    return validatePatch(patch);
  }

  const role = text.match(/(?:роль|я\s+(?:работаю\s+)?(?:как\s+)?)\s*[-—:]?\s*([^.;\n]+)/iu);
  if (role?.[1] && !/^(?:поддержка|эффективность)$/iu.test(role[1].trim())) patch.role = clean(role[1]);
  const taskMatch = text.match(/(?:задач[аи]|занимаюсь|делаю|типичн(?:ые|ая)\s+задач[аи])\s*[-—:]?\s*([^\n.]+)/iu);
  if (taskMatch?.[1]) patch.typicalTasks = tasks(taskMatch[1]);

  patch.persona = persona(normalized);
  patch.aiLevel = aiLevel(normalized);

  // A direct answer to a focused question is safe only for free-form fields.
  if (input.currentDraft.pendingField === "role" && !patch.role && !patch.persona && !patch.aiLevel && looksLikeRole(text)) patch.role = text;
  if (input.currentDraft.pendingField === "typicalTasks" && !patch.typicalTasks && !patch.persona && !patch.aiLevel) patch.typicalTasks = tasks(text);
  return validatePatch(patch);
}

export function normalizePersona(value: string): Persona | undefined {
  const text = normalize(value);
  if (/(?:support|поддержк\w*|бережн\w*)/u.test(text)) return "support";
  if (/(?:efficiency|эффективност\w*|по делу|коротко и практично)/u.test(text)) return "efficiency";
  return undefined;
}
export function normalizeAiLevel(value: string): AiLevel | undefined {
  const text = normalize(value);
  if (/(?:beginner|нович\w*|не пользовал\w*|только начина\w*)/u.test(text)) return "beginner";
  if (/(?:advanced|продвинут\w*|уверенно использую)/u.test(text)) return "advanced";
  if (/(?:intermediate|немного работал\w*|базов\w* опыт|средн\w* уровень|работал с ии|работаю с ии)/u.test(text)) return "intermediate";
  return undefined;
}

function persona(value: string): Persona | undefined { return normalizePersona(value); }
function aiLevel(value: string): AiLevel | undefined { return normalizeAiLevel(value); }
function normalize(value: string): string { return value.toLocaleLowerCase("ru-RU").replace(/[«»"']/g, " ").replace(/\s+/g, " ").trim(); }
function clean(value: string): string { return value.trim().replace(/^(?:я\s+)?(?:работаю\s+)?(?:как\s+)?/iu, "").trim(); }
function looksLikeRole(value: string): boolean { return value.trim().split(/\s+/u).length >= 2 && !/^(?:привет|здравствуйте|добрый день)[!. ]*$/iu.test(value.trim()); }
function tasks(value: string): string[] | undefined {
  const values = value.split(/[;,]|\s+и\s+/iu).map(clean).filter(Boolean);
  return values.length >= 1 && values.length <= 7 ? values : undefined;
}
function validatePatch(patch: OnboardingProfilePatch): OnboardingProfilePatch {
  if (patch.role && !patch.role.trim()) delete patch.role;
  if (patch.typicalTasks && (patch.typicalTasks.length < 1 || patch.typicalTasks.length > 7 || patch.typicalTasks.some((task) => !task.trim()))) delete patch.typicalTasks;
  return patch;
}

export function emptyOnboardingPatch(): OnboardingProfilePatch { return { ambiguousFields: [] as OnboardingField[] }; }
