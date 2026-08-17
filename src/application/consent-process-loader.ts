import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "./agent-manual-loader.js";

const consentProcessPath = "vault/assistant/processes/consent_and_privacy.md";
const consentShortStartMarker = "<!-- minutka-consent-short:start -->";
const consentShortEndMarker = "<!-- minutka-consent-short:end -->";
const consentFullStartMarker = "<!-- minutka-consent-full:start -->";
const consentFullEndMarker = "<!-- minutka-consent-full:end -->";
const privacyPolicyUrlPlaceholder = "{{privacyPolicyUrl}}";

export type PrivacyExplanation = {
  short: string;
  full: string;
};

export function createPrivacyExplanation(
  privacyPolicyUrl: string,
  input: { repoRoot?: string } = {},
): PrivacyExplanation {
  const repoRoot = findRepoRoot(input.repoRoot ?? process.cwd());
  const consentProcess = readFileSync(resolve(repoRoot, consentProcessPath), "utf8");
  return {
    short: readConsentBlock(consentProcess, "short", consentShortStartMarker, consentShortEndMarker, privacyPolicyUrl),
    full: readConsentBlock(consentProcess, "full", consentFullStartMarker, consentFullEndMarker, privacyPolicyUrl),
  };
}

function readConsentBlock(
  consentProcess: string,
  name: "short" | "full",
  startMarker: string,
  endMarker: string,
  privacyPolicyUrl: string,
): string {
  const start = consentProcess.indexOf(startMarker);
  const end = consentProcess.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`consent process must contain one ordered ${startMarker}/${endMarker} block`);
  }

  const text = consentProcess.slice(start + startMarker.length, end).trim();
  const placeholderCount = text.split(privacyPolicyUrlPlaceholder).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(`consent process ${name} block must contain ${privacyPolicyUrlPlaceholder} exactly once`);
  }

  return text.replace(privacyPolicyUrlPlaceholder, privacyPolicyUrl);
}
