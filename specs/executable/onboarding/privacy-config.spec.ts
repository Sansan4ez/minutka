import { describe, expect, it } from "vitest";
import { privacyConfigFromEnv, privacyPolicyUrlEnvName } from "../../../src/config/privacy.js";

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";

describe("privacy-v2 deployment policy URL", () => {
  it("builds the consent text from a canonical versioned HTTPS URL", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: "https://privacy.example.com/policies/privacy-v2.html",
    });

    expect(config.policyUrl).toBe("https://privacy.example.com/policies/privacy-v2.html");
    expect(config.explanation).toContain(config.policyUrl);
  });

  it("accepts immutable GitHub document links pinned to a full commit SHA", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: `https://github.com/example/assistant/blob/${pinnedCommit}/privacy-boundary.md`,
    });

    expect(config.policyUrl).toContain(pinnedCommit);
  });

  it.each([
    ["missing", undefined],
    ["non-HTTPS", "http://privacy.example.com/privacy-v2.html"],
    ["unversioned path", "https://privacy.example.com/privacy.html"],
    ["mutable GitHub branch", "https://github.com/example/assistant/blob/main/privacy-boundary.md"],
    ["mutable raw GitHub branch", "https://raw.githubusercontent.com/example/assistant/main/privacy-boundary.md"],
    ["query parameters", "https://privacy.example.com/privacy-v2.html?latest=true"],
  ])("rejects %s policy configuration", (_case, policyUrl) => {
    expect(() => privacyConfigFromEnv(policyUrl === undefined ? {} : { [privacyPolicyUrlEnvName]: policyUrl })).toThrow(privacyPolicyUrlEnvName);
  });
});
