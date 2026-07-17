import { describe, expect, it } from "vitest";
import { createResponsePolicy, renderResponsePolicy } from "../../../src/domain/response-policy.js";
import { maxTelegramMessageCharacters, splitTelegramMessage, telegramMessageLength } from "../../../src/telegram/telegram-shell.js";
import { createSpecWorld } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";

describe("SPEC-TELEGRAM-RESPONSES-001: Telegram-aware response policy and delivery", () => {
  it.each([
    ["short", 800, 3],
    ["balanced", 1_200, 4],
    ["detailed", 1_500, 5],
  ] as const)("documents the %s Telegram budget", (preferredLength, targetCharacters, maximumBlocks) => {
    const policy = createResponsePolicy({ channel: "telegram", preferredLength });
    expect(policy).toMatchObject({ channel: "telegram", preferredLength, targetCharacters, maximumBlocks });
    expect(renderResponsePolicy(policy)).toContain("summary now and offer continuation in parts or a separate artifact");
  });

  it("passes the trusted Telegram policy and profile preference to the agent", async () => {
    let systemContext = "";
    const runner = async (_input: unknown, context?: { systemContext?: string }) => {
      systemContext = context?.systemContext ?? "";
      return "Краткий ответ.";
    };
    const spec = createSpecWorld(runner);
    await onboardTestEmployee(spec, { responseLength: "detailed" });
    const telegram = new TelegramDriver(spec.world, runner);
    await telegram.start({ chatId: "chat_policy", userId: "policy_user", inviteCode: "invite_test_1" });
    const consentCallback = telegram.sentMessages()[0]?.replyMarkup?.inlineKeyboard[0]?.[0]?.callbackData;
    expect(consentCallback).toBeTruthy();
    await telegram.clickCallback({ chatId: "chat_policy", userId: "policy_user", callbackData: consentCallback! });
    telegram.clear();

    await telegram.sendText({ chatId: "chat_policy", userId: "policy_user", text: "Расскажи про меня" });

    expect(systemContext).toContain("## Trusted response policy");
    expect(systemContext).toContain("Channel: telegram");
    expect(systemContext).toContain("Preferred response length: detailed");
    expect(systemContext).toContain("Target budget: about 1500 Unicode characters; no more than 5 short blocks.");
  });

  it("splits long responses at semantic boundaries and preserves Unicode", () => {
    const paragraph = `${"🙂".repeat(1_950)} конец первого абзаца.`;
    const list = Array.from({ length: 80 }, (_, index) => `- пункт ${index + 1}: ${"данные ".repeat(12)}`).join("\n");
    const source = `${paragraph}\n\n${list}\n\n${"Финал. ".repeat(500)}`;

    const chunks = splitTelegramMessage(source);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => telegramMessageLength(chunk) <= maxTelegramMessageCharacters)).toBe(true);
    expect(chunks[0]).toBe(paragraph);
    expect(chunks.join("\n")).toContain("🙂".repeat(100));
    expect(chunks.join("\n")).toContain("- пункт 80");
  });

  it("uses Telegram UTF-16 units for Unicode-safe hard splits", () => {
    const source = "🧭".repeat(maxTelegramMessageCharacters + 17);
    const chunks = splitTelegramMessage(source);

    expect(chunks.map(telegramMessageLength)).toEqual([maxTelegramMessageCharacters, maxTelegramMessageCharacters, 34]);
    expect(chunks.join("")).toBe(source);
    expect(chunks.every((chunk) => telegramMessageLength(chunk) <= maxTelegramMessageCharacters)).toBe(true);
  });

  it("does not emit an empty chunk for a long whitespace prefix", () => {
    const source = `${" ".repeat(maxTelegramMessageCharacters)}важный ответ`;
    const chunks = splitTelegramMessage(source);

    expect(chunks).toEqual(["важный ответ"]);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });

  it("keeps fenced plain text lossless until the renderer owns markup-aware splitting", () => {
    const source = `\`\`\`text\n${"x".repeat(maxTelegramMessageCharacters)}\n\`\`\``;
    const chunks = splitTelegramMessage(source);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(source);
    expect(chunks.every((chunk) => telegramMessageLength(chunk) <= maxTelegramMessageCharacters)).toBe(true);
  });
});
