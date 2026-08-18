import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessSchedule } from "../domain/schedule.js";
import type { UserProfile } from "../domain/employee.js";
import { findRepoRoot } from "./agent-manual-loader.js";

const welcomeTextPath = "vault/assistant/texts/onboarding_welcome.md";
const welcomeStartMarker = "<!-- minutka-welcome:start -->";
const welcomeEndMarker = "<!-- minutka-welcome:end -->";
const welcomePlaceholders = {
  preferredName: "{{preferredName}}",
  morningTime: "{{morningTime}}",
  eveningTime: "{{eveningTime}}",
} as const;

export function createOnboardingWelcome(
  profile: Pick<UserProfile, "preferredName">,
  schedules: ProcessSchedule[],
  input: { repoRoot?: string } = {},
): string {
  const repoRoot = findRepoRoot(input.repoRoot ?? process.cwd());
  const source = readFileSync(resolve(repoRoot, welcomeTextPath), "utf8");
  const template = extractWelcomeTemplate(source);
  const morningTime = scheduleTime(schedules, "morning_activity_collection");
  const eveningTime = scheduleTime(schedules, "evening_reflection");
  if (!profile.preferredName.trim()) throw new Error("welcome preferredName must not be empty");

  return template
    .replace(welcomePlaceholders.preferredName, profile.preferredName)
    .replace(welcomePlaceholders.morningTime, morningTime)
    .replace(welcomePlaceholders.eveningTime, eveningTime);
}

function extractWelcomeTemplate(source: string): string {
  const starts = occurrenceIndexes(source, welcomeStartMarker);
  const ends = occurrenceIndexes(source, welcomeEndMarker);
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) {
    throw new Error(`welcome text must contain one ordered ${welcomeStartMarker}/${welcomeEndMarker} block`);
  }

  const template = source.slice(starts[0]! + welcomeStartMarker.length, ends[0]!).trim();
  if (!template) throw new Error("welcome text block must not be empty");
  for (const placeholder of Object.values(welcomePlaceholders)) {
    if (occurrenceIndexes(template, placeholder).length !== 1) {
      throw new Error(`welcome text must contain ${placeholder} exactly once`);
    }
  }
  return template;
}

function scheduleTime(schedules: ProcessSchedule[], processId: string): string {
  const schedule = schedules.find((candidate) => candidate.kind === "process" && candidate.processId === processId);
  if (!schedule) throw new Error(`welcome schedule is missing: ${processId}`);
  return schedule.timeOfDay;
}

function occurrenceIndexes(text: string, value: string): number[] {
  const indexes: number[] = [];
  let fromIndex = 0;
  while (true) {
    const index = text.indexOf(value, fromIndex);
    if (index === -1) return indexes;
    indexes.push(index);
    fromIndex = index + value.length;
  }
}
