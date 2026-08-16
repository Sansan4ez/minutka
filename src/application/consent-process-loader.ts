import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "./agent-manual-loader.js";

const consentProcessPath = "vault/assistant/processes/consent_and_privacy.md";
const consentStartMarker = "<!-- minutka-consent:start -->";
const consentEndMarker = "<!-- minutka-consent:end -->";
const privacyPolicyUrlPlaceholder = "{{privacyPolicyUrl}}";

export function createPrivacyExplanation(
  privacyPolicyUrl: string,
  input: { repoRoot?: string } = {},
): string {
  const repoRoot = findRepoRoot(input.repoRoot ?? process.cwd());
  const consentProcess = readFileSync(resolve(repoRoot, consentProcessPath), "utf8");
  const start = consentProcess.indexOf(consentStartMarker);
  const end = consentProcess.indexOf(consentEndMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`consent process must contain one ordered ${consentStartMarker}/${consentEndMarker} block`);
  }

  const text = consentProcess.slice(start + consentStartMarker.length, end).trim();
  if (!text || !text.includes(privacyPolicyUrlPlaceholder)) {
    throw new Error(`consent process must contain ${privacyPolicyUrlPlaceholder}`);
  }
  if (text.indexOf(privacyPolicyUrlPlaceholder) !== text.lastIndexOf(privacyPolicyUrlPlaceholder)) {
    throw new Error(`consent process must contain ${privacyPolicyUrlPlaceholder} exactly once`);
  }

  return text.replace(privacyPolicyUrlPlaceholder, privacyPolicyUrl);
}
