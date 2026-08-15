import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const currentPrivacyVersion = "privacy-v3" as const;
export type PrivacyVersion = "privacy-v1" | "privacy-v2" | typeof currentPrivacyVersion;

const consentProcessPath = "vault/assistant/processes/consent_and_privacy.md";
const consentStartMarker = "<!-- minutka-consent:start -->";
const consentEndMarker = "<!-- minutka-consent:end -->";
const privacyPolicyUrlPlaceholder = "{{privacyPolicyUrl}}";

export function createPrivacyExplanation(privacyPolicyUrl: string, repoRoot = process.cwd()): string {
  const process = readFileSync(safeRepoPath(repoRoot, consentProcessPath), "utf8");
  const start = process.indexOf(consentStartMarker);
  const end = process.indexOf(consentEndMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`consent process must contain one ordered ${consentStartMarker}/${consentEndMarker} block`);
  }
  const text = process.slice(start + consentStartMarker.length, end).trim();
  if (!text || !text.includes(privacyPolicyUrlPlaceholder)) {
    throw new Error(`consent process must contain ${privacyPolicyUrlPlaceholder}`);
  }
  if (text.indexOf(privacyPolicyUrlPlaceholder) !== text.lastIndexOf(privacyPolicyUrlPlaceholder)) {
    throw new Error(`consent process must contain ${privacyPolicyUrlPlaceholder} exactly once`);
  }
  return text.replace(privacyPolicyUrlPlaceholder, privacyPolicyUrl);
}

function safeRepoPath(repoRoot: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`consent process path must be repository-relative: ${path}`);
  const root = resolve(repoRoot);
  const absolute = resolve(root, path);
  const pathFromRoot = relative(root, absolute);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`consent process path escapes repository: ${path}`);
  }
  return absolute;
}
