import { describe, expect, it } from "vitest";
import { privacyConfigFromEnv, privacyPolicyUrlEnvName } from "../../../src/config/privacy.js";

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";

describe("privacy-v4 deployment policy URL", () => {
  // Asserting the literal keeps the derived name in step with .env.example and
  // the runbook; indexing env by the exported constant alone cannot catch drift.
  it("reads the environment variable documented for deployment", () => {
    expect(privacyPolicyUrlEnvName).toBe("PRIVACY_POLICY_V4_URL");
  });

  it("builds the consent text from a canonical versioned HTTPS URL", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: "https://privacy.example.com/policies/privacy-v4.html",
    });

    expect(config.policyUrl).toBe("https://privacy.example.com/policies/privacy-v4.html");
    expect(config.explanation).toContain(config.policyUrl);
    expect(config.explanation).toContain("обезличенный след");
    expect(config.explanation).toContain("Доверенный внутренний методолог видит обезличенные записи без имён и свободного текста");
    expect(config.explanation).toContain("не менее 5 участников и не менее 5 обезличенных записей");
    expect(config.explanation).toContain("до подготовки и передачи отчёта компании");
    expect(config.explanation).toContain("В самой обезличенной строке нет идентификатора сотрудника");
    expect(config.explanation).toContain("мы не ищем, не удаляем точечно и не пересчитываем отдельные обезличенные строки");
    expect(config.explanation).toContain("потребовать удалить личные данные");
    expect(config.explanation).toContain("персональный запрос не удаляет и не пересчитывает их");
    expect(config.explanation).toContain("Правило не менее 5 ограничивает аналитические срезы компании");
    expect(config.explanation).toContain("методолог может сообщить руководителю компании только факт участия");
    expect(config.explanation).toContain("выбранное имя обращения без маскировки");
    expect(config.explanation).not.toMatch(/найти и удалить её точечно или пересчитать нельзя/i);
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
    ["non-HTTPS", "http://privacy.example.com/privacy-v4.html"],
    ["unversioned path", "https://privacy.example.com/privacy.html"],
    ["mutable GitHub branch", "https://github.com/example/assistant/blob/main/privacy-boundary.md"],
    ["mutable raw GitHub branch", "https://raw.githubusercontent.com/example/assistant/main/privacy-boundary.md"],
    ["query parameters", "https://privacy.example.com/privacy-v4.html?latest=true"],
  ])("rejects %s policy configuration", (_case, policyUrl) => {
    expect(() => privacyConfigFromEnv(policyUrl === undefined ? {} : { [privacyPolicyUrlEnvName]: policyUrl })).toThrow(privacyPolicyUrlEnvName);
  });
});
