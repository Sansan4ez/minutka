import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { privacyConfigFromEnv, privacyPolicyUrlEnvName } from "../../../src/config/privacy.js";
import { currentPrivacyVersion } from "../../../src/domain/privacy.js";

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";

describe("privacy-v6 deployment policy URL", () => {
  // Asserting the literal keeps the derived name in step with .env.example and
  // the runbook; indexing env by the exported constant alone cannot catch drift.
  it("reads the environment variable documented for deployment", () => {
    expect(currentPrivacyVersion).toBe("privacy-v6");
    expect(privacyPolicyUrlEnvName).toBe("PRIVACY_POLICY_V6_URL");
  });

  it("keeps v5 immutable and publishes v6 as the active snapshot", () => {
    const archivedV5 = readFileSync("docs/product/privacy-v5.html");
    expect(createHash("sha256").update(archivedV5).digest("hex")).toBe("22213c1e0c589d06d69a1a77db2866822f14612e28b66ed05ed6348dbab4864c");

    const activeV6 = readFileSync("docs/product/privacy-v6.html", "utf8");
    expect(activeV6).toContain("версия <strong>privacy-v6</strong>");
    expect(activeV6).toContain("полный корпус явно выбранной компании и учебной группы");
    expect(activeV6).toContain("не используется оператором для обучения или fine-tuning моделей");
    expect(activeV6).toContain("только отдельно подготовленный client report");
    expect(activeV6).toContain("автоматический срок удаления в пилоте не установлен");
    expect(activeV6).not.toMatch(/Черновик, не активная политика|Runtime продолжает использовать privacy-v5/iu);
  });

  it("forces existing Telegram sessions through privacy-v6 re-consent", () => {
    const migration = readFileSync("migrations/0059_reconsent_privacy_v6.sql", "utf8");
    expect(migration).toContain("SET consent_accepted_at = NULL");
    expect(migration).toContain("consent.privacy_version IS DISTINCT FROM 'privacy-v6'");
  });

  it("builds the consent text from a canonical versioned HTTPS URL", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: "https://privacy.example.com/policies/privacy-v6.html",
    });

    expect(config.policyUrl).toBe("https://privacy.example.com/policies/privacy-v6.html");
    expect(config.explanation).toContain(config.policyUrl);
    expect(config.explanation).toContain("полный корпус");
    expect(config.explanation).toContain("разговоры, активности, feedback и технические execution traces");
    expect(config.explanation).toContain("улучшения промптов и таксономии");
    expect(config.explanation).toContain("для обучения и fine-tuning моделей он не используется");
    expect(config.explanation).toContain("Компания получает только проверенный итоговый отчёт");
    expect(config.explanation).toContain("Автоматического срока удаления в пилоте нет");
    expect(config.explanation).toContain("по сотруднику, группе или компании");
    expect(config.explanation.length).toBeLessThanOrEqual(1_200);
    expect(config.explanation).not.toMatch(/не менее 5|обезличенн(?:ый|ые) след|живут до отч[её]та/iu);
    expect(config.fullExplanation).toContain(config.policyUrl);
    expect(config.fullExplanation).toContain("Доверенная исследовательская команда «Алгоритма» может читать полный tenant-scoped корпус");
    expect(config.fullExplanation).toContain("это псевдонимизация, а не обещание необратимой анонимности");
    expect(config.fullExplanation).toContain("Компания-клиент не получает доступ к корпусу, traces, `subject_key`");
    expect(config.fullExplanation).toContain("Ручной purge компании");
    expect(config.fullExplanation).toContain("отчёт пересчитывается");
  });

  it("accepts immutable GitHub document links pinned to a full commit SHA", () => {
    const config = privacyConfigFromEnv({
      [privacyPolicyUrlEnvName]: `https://github.com/example/assistant/blob/${pinnedCommit}/privacy-boundary.md`,
    });

    expect(config.policyUrl).toContain(pinnedCommit);
  });

  it.each([
    ["missing", undefined],
    ["non-HTTPS", "http://privacy.example.com/privacy-v6.html"],
    ["unversioned path", "https://privacy.example.com/privacy.html"],
    ["mutable GitHub branch", "https://github.com/example/assistant/blob/main/privacy-boundary.md"],
    ["mutable raw GitHub branch", "https://raw.githubusercontent.com/example/assistant/main/privacy-boundary.md"],
    ["query parameters", "https://privacy.example.com/privacy-v6.html?latest=true"],
  ])("rejects %s policy configuration", (_case, policyUrl) => {
    expect(() => privacyConfigFromEnv(policyUrl === undefined ? {} : { [privacyPolicyUrlEnvName]: policyUrl })).toThrow(privacyPolicyUrlEnvName);
  });
});
