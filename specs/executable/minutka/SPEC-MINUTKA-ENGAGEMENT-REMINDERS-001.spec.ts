import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerSpecMetadata } from "../support/spec-harness.js";

registerSpecMetadata({
  id: "SPEC-MINUTKA-ENGAGEMENT-REMINDERS-001",
  userStory: "US-MINUTKA-ENGAGEMENT-REMINDERS-001",
  requirements: ["FR-MINUTKA-ENGAGEMENT-REMINDERS-001"],
  productParts: ["data-storage-and-privacy-layer", "telegram-shell"],
  contracts: ["operatorReminderRunbook", "privacyBoundary"],
  events: [],
  mastra: [],
  cli: [],
});

const runbook = readFileSync("docs/runbooks/participant-engagement-reminders.md", "utf8");
const skillsMap = readFileSync("docs/product/skills-map.md", "utf8");
const privacy = readFileSync("vault/assistant/docs/privacy-boundary.md", "utf8");
const consent = readFileSync("vault/assistant/processes/consent_and_privacy.md", "utf8");

function expectThreeTiers(text: string): void {
  expect(text).toMatch(/бот|bot|reminder/iu);
  expect(text).toMatch(/методолог|methodologist/iu);
  expect(text).toMatch(/руководител|company lead/iu);
  expect(text).toMatch(/только факт(?:а)? участия|only the participation(?:\/non-participation)? fact/iu);
}

describe("SPEC-MINUTKA-ENGAGEMENT-REMINDERS-001: reminder operating contract", () => {
  it("documents preview, level-2 confirmation, outcomes, and a rolling daily cooldown", () => {
    expect(runbook).toContain("полный текст сообщения без сокращения");
    expect(runbook).toContain("число найденных адресатов");
    expect(runbook).toContain("level-2 TTY challenge");
    expect(runbook).toContain("скользящие 24 часа");
    expect(runbook).toContain("обхода `--force` на пилоте нет");
    for (const outcome of ["delivered", "cooldown", "delivery_session_missing", "failed"]) {
      expect(runbook).toContain(`\`${outcome}\``);
    }
  });

  it("keeps recipient selection and escalation independent of employee conversations", () => {
    expect(runbook).toContain("содержание разговоров, activities, traces, insights и персональные выводы для отбора не читаются");
    expect(privacy).toContain("conversation content, activities, traces, insights, inferred reasons, and judgements are not inputs");
    expect(consent).toContain("Conversation content is not used");
  });

  it("states the three escalation tiers and does not overstate runtime availability", () => {
    for (const text of [runbook, skillsMap, privacy, consent]) expectThreeTiers(text);
    expect(runbook).toContain("Групповой Telegram-команды для отправки напоминаний в текущем runtime пока нет");
    expect(skillsMap).toContain("сама групповая Telegram-команда в runtime ещё не подключена");
    expect(runbook).toContain("запрещено имитировать рассылку прямым SQL");
  });

  it("fixes a soft default message that discloses later escalation without pressure", () => {
    expect(runbook).toContain("без оценки и обязательной формы");
    expect(runbook).toContain("с вами может связаться методолог программы");
    expect(runbook).toContain("только факт участия или отсутствия участия, без содержания переписки");
    expect(runbook).toContain("не должен содержать давление, стыд, сравнение с другими участниками, оценку продуктивности");
  });
});
