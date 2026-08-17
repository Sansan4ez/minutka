import { createPrivacyExplanation } from "../application/consent-process-loader.js";
import { currentPrivacyVersion } from "../domain/privacy.js";

// The version already carries the `privacy-` prefix that the name starts with;
// stripping it keeps PRIVACY_POLICY_V5_URL rather than doubling the prefix.
export const privacyPolicyUrlEnvName = `PRIVACY_POLICY_${currentPrivacyVersion.replace(/^privacy-/u, "").toUpperCase()}_URL` as const;

export type PrivacyConfig = {
  policyUrl: string;
  explanation: string;
  fullExplanation: string;
};

/**
 * Loads the canonical policy snapshot referenced by the current consent version.
 *
 * Generic HTTPS endpoints must carry the privacy version in their path. GitHub
 * and raw GitHub document links are accepted only when pinned to a full commit
 * SHA. Availability without repository credentials remains a deployment
 * preflight responsibility because startup must not download policy content.
 */
export function privacyConfigFromEnv(env: NodeJS.ProcessEnv): PrivacyConfig {
  const value = env[privacyPolicyUrlEnvName]?.trim();
  if (!value) throw new Error(`${privacyPolicyUrlEnvName} is required and must reference the public immutable ${currentPrivacyVersion} policy snapshot`);

  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${privacyPolicyUrlEnvName} must be a valid HTTPS URL`); }

  if (url.protocol !== "https:") throw new Error(`${privacyPolicyUrlEnvName} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${privacyPolicyUrlEnvName} must not contain credentials`);
  if (url.search || url.hash) throw new Error(`${privacyPolicyUrlEnvName} must be a canonical URL without query parameters or a fragment`);

  const immutableGitReference = gitDocumentReference(url);
  if (immutableGitReference === false) {
    throw new Error(`${privacyPolicyUrlEnvName} Git document URLs must be pinned to a full 40-character commit SHA, not a mutable branch or tag`);
  }
  if (immutableGitReference === undefined && !pathContainsPrivacyVersion(url.pathname)) {
    throw new Error(`${privacyPolicyUrlEnvName} must include ${currentPrivacyVersion} in its path or pin a Git document to a full commit SHA`);
  }

  const policyUrl = url.toString();
  const explanation = createPrivacyExplanation(policyUrl);
  return { policyUrl, explanation: explanation.short, fullExplanation: explanation.full };
}

function gitDocumentReference(url: URL): boolean | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com" && segments[2] === "blob" && segments[3]) return /^[0-9a-f]{40}$/i.test(segments[3]);
  if (url.hostname === "raw.githubusercontent.com" && segments[2]) return /^[0-9a-f]{40}$/i.test(segments[2]);
  return undefined;
}

function pathContainsPrivacyVersion(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === currentPrivacyVersion || segment.startsWith(`${currentPrivacyVersion}.`));
}
