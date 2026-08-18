import { describe, expect, it } from "vitest";
import { privacyConfigFromEnv, privacyPolicyUrlEnvName } from "../../../src/config/privacy.js";

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";

describe("privacy-v5 deployment policy URL", () => {
  // Asserting the literal keeps the derived name in step with .env.example and
  // the runbook; indexing env by the exported constant alone cannot catch drift.
  it("reads the environment variable documented for deployment", () => {
    expect(privacyPolicyUrlEnvName).toBe("PRIVACY_POLICY_V5_URL");
  });

  it("builds the consent text from a canonical versioned HTTPS URL", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: "https://privacy.example.com/policies/privacy-v5.html",
    });

    expect(config.policyUrl).toBe("https://privacy.example.com/policies/privacy-v5.html");
    expect(config.explanation).toContain(config.policyUrl);
    expect(config.explanation).toContain("за пару минут");
    expect(config.explanation).toContain("личном контуре");
    expect(config.explanation).toContain("Методолог видит обезличенные записи");
    expect(config.explanation).toContain("Компания получает срезы только от 5 участников");
    expect(config.explanation).toContain("LLM-провайдеру");
    expect(config.explanation).toContain("Личные данные удаляются через оператора");
    expect(config.explanation).toContain("живут до отчёта");
    expect(config.explanation).toContain("точечно их не ищем и не пересчитываем");
    expect(config.explanation.length).toBeLessThanOrEqual(1_000);
    expect(config.explanation).not.toMatch(/компания и методолог видят только агрегаты от пяти человек/i);
    expect(config.explanation).not.toMatch(/вы видите все свои данные/i);
    expect(config.fullExplanation).toContain(config.policyUrl);
    expect(config.fullExplanation).toContain("мы не ищем, не удаляем точечно и не пересчитываем отдельные обезличенные строки");
    expect(config.fullExplanation).toContain("Правило не менее 5 ограничивает аналитические срезы компании");
  });

  it("accepts immutable GitHub document links pinned to a full commit SHA", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: `https://github.com/example/assistant/blob/${pinnedCommit}/privacy-boundary.md`,
    });

    expect(config.policyUrl).toContain(pinnedCommit);
  });

  it.each([
    ["missing", undefined],
    ["non-HTTPS", "http://privacy.example.com/privacy-v5.html"],
    ["unversioned path", "https://privacy.example.com/privacy.html"],
    ["mutable GitHub branch", "https://github.com/example/assistant/blob/main/privacy-boundary.md"],
    ["mutable raw GitHub branch", "https://raw.githubusercontent.com/example/assistant/main/privacy-boundary.md"],
    ["query parameters", "https://privacy.example.com/privacy-v5.html?latest=true"],
  ])("rejects %s policy configuration", (_case, policyUrl) => {
    expect(() => privacyConfigFromEnv(policyUrl === undefined ? {} : { [privacyPolicyUrlEnvName]: policyUrl })).toThrow(privacyPolicyUrlEnvName);
  });
});
