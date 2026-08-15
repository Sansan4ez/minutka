import { describe, expect, it } from "vitest";
import { privacyConfigFromEnv, privacyPolicyUrlEnvName } from "../../../src/config/privacy.js";

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";

describe("privacy-v3 deployment policy URL", () => {
  // Asserting the literal keeps the derived name in step with .env.example and
  // the runbook; indexing env by the exported constant alone cannot catch drift.
  it("reads the environment variable documented for deployment", () => {
    expect(privacyPolicyUrlEnvName).toBe("PRIVACY_POLICY_V3_URL");
  });

  it("builds the consent text from a canonical versioned HTTPS URL", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: "https://privacy.example.com/policies/privacy-v3.html",
    });

    expect(config.policyUrl).toBe("https://privacy.example.com/policies/privacy-v3.html");
    expect(config.explanation).toContain(config.policyUrl);
    expect(config.explanation).toContain("обезличенный след");
    expect(config.explanation).toContain("Доверенный внутренний методолог видит обезличенные записи и агрегаты");
    expect(config.explanation).toContain("не менее 5 участников и не менее 5 обезличенных записей");
    expect(config.explanation).toContain("до подготовки и передачи отчёта компании");
    expect(config.explanation).toContain("найти и удалить её точечно");
    expect(config.explanation).toContain("потребовать удалить личные данные");
    expect(config.explanation).toContain("Правило не менее 5 ограничивает только то, что видит компания");
    expect(config.explanation).not.toMatch(/ваши данные видит только компания в агрегатах от пяти человек/i);
  });

  it("accepts immutable GitHub document links pinned to a full commit SHA", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: `https://github.com/example/assistant/blob/${pinnedCommit}/privacy-boundary.md`,
    });

    expect(config.policyUrl).toContain(pinnedCommit);
  });

  it.each([
    ["missing", undefined],
    ["non-HTTPS", "http://privacy.example.com/privacy-v3.html"],
    ["unversioned path", "https://privacy.example.com/privacy.html"],
    ["mutable GitHub branch", "https://github.com/example/assistant/blob/main/privacy-boundary.md"],
    ["mutable raw GitHub branch", "https://raw.githubusercontent.com/example/assistant/main/privacy-boundary.md"],
    ["query parameters", "https://privacy.example.com/privacy-v3.html?latest=true"],
  ])("rejects %s policy configuration", (_case, policyUrl) => {
    expect(() => privacyConfigFromEnv(policyUrl === undefined ? {} : { [privacyPolicyUrlEnvName]: policyUrl })).toThrow(privacyPolicyUrlEnvName);
  });
});
