import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "./agent-manual-loader.js";

const reminderTextPath = "vault/assistant/texts/engagement_reminder.md";
const reminderStartMarker = "<!-- minutka-engagement-reminder:start -->";
const reminderEndMarker = "<!-- minutka-engagement-reminder:end -->";

/**
 * Reads the single soft reminder that every lagging participant receives. The
 * text is fixed on disk and delivered verbatim: no placeholders, no per-employee
 * wording, and no model in the loop.
 */
export function readEngagementReminderText(input: { repoRoot?: string } = {}): string {
  const repoRoot = findRepoRoot(input.repoRoot ?? process.cwd());
  const source = readFileSync(resolve(repoRoot, reminderTextPath), "utf8");
  const start = source.indexOf(reminderStartMarker);
  const end = source.indexOf(reminderEndMarker);
  if (start === -1 || end <= start || source.indexOf(reminderStartMarker, start + 1) !== -1) {
    throw new Error(`reminder text must contain one ordered ${reminderStartMarker}/${reminderEndMarker} block`);
  }
  const text = source.slice(start + reminderStartMarker.length, end).trim();
  if (!text) throw new Error("reminder text block must not be empty");
  return text;
}
