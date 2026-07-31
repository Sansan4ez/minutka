import { describe, expect, it } from "vitest";
import { createResponsePolicy, renderResponsePolicy } from "../../../src/domain/response-policy.js";
import { deliverTelegramMessage, maxTelegramMessageCharacters, splitTelegramMessage, telegramMessageLength } from "../../../src/telegram/telegram-shell.js";
import { renderTelegramMarkdown, renderTelegramPlainText, splitTelegramHtml, telegramMarkdownToHtml } from "../../../src/telegram/telegram-renderer.js";
import type { TelegramReplyPort } from "../../../src/telegram/telegram-types.js";
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

  it("renders the supported Markdown subset as escaped Telegram HTML", () => {
    const html = telegramMarkdownToHtml([
      "# Итог",
      "**Важно:** пользователь <Admin> & команда __готовы__.",
      "- открыть [документ](https://example.com/a?x=1&y=2)",
      "- выполнить `echo <secret>`",
      "```ts",
      "const unsafe = '<tag> & data';",
      "```",
    ].join("\n"));

    expect(html).toContain("<b>Итог</b>");
    expect(html).toContain("<b>Важно:</b> пользователь &lt;Admin&gt; &amp; команда <i>готовы</i>.");
    expect(html).toContain("• открыть <a href=\"https://example.com/a?x=1&amp;y=2\">документ</a>");
    expect(html).toContain("<code>echo &lt;secret&gt;</code>");
    expect(html).toContain("<pre><code>const unsafe = '&lt;tag&gt; &amp; data';</code></pre>");
    expect(html).not.toContain("<Admin>");
  });

  it("degrades malformed or unsafe model markup without exposing raw markers or injection", () => {
    const html = telegramMarkdownToHtml("Незакрыто **важно и `код <x> [опасно](javascript:alert(1)) <b>raw</b>");

    expect(html).toBe("Незакрыто важно и код &lt;x&gt; опасно (javascript:alert(1)) &lt;b&gt;raw&lt;/b&gt;");
    expect(html).not.toMatch(/\*\*|`/u);
  });

  it("treats user-derived product fields as plain text, never trusted markup", () => {
    expect(renderTelegramPlainText("Алекс **админ** <b>root</b> & Co")).toEqual([{ text: "Алекс **админ** &lt;b&gt;root&lt;/b&gt; &amp; Co", parseMode: "HTML" }]);
  });

  it("chunks rendered HTML without splitting entities or leaving tags unbalanced", () => {
    const chunks = renderTelegramMarkdown(`**${"<&🙂".repeat(1_500)}**\n\n\`done\``);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(({ text, parseMode }) => parseMode === "HTML" && telegramMessageLength(text) <= maxTelegramMessageCharacters)).toBe(true);
    expect(chunks.every(({ text }) => (text.match(/<b>/g) ?? []).length === (text.match(/<\/b>/g) ?? []).length)).toBe(true);
    expect(chunks.every(({ text }) => !/&(?:am|l|g)$/u.test(text))).toBe(true);
    expect(splitTelegramHtml(chunks.map(({ text }) => text).join(""))).not.toEqual([]);
  });

  it("passes HTML parse mode through the Telegram reply port", async () => {
    const sent: Array<{ text: string; parseMode?: string }> = [];
    const replyPort: TelegramReplyPort = {
      async sendMessage(_chatId, text, options) { sent.push({ text, parseMode: options?.parseMode }); return { messageId: sent.length }; },
      async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {},
    };

    await deliverTelegramMessage(replyPort, "chat", "**Готово** & безопасно");

    expect(sent).toEqual([{ text: "<b>Готово</b> &amp; безопасно", parseMode: "HTML" }]);
  });

  it("renders agent responses through the production-like Telegram driver", async () => {
    const runner = async () => "**Важно**\n- [ссылка](https://example.com)\n- `код <x>`";
    const spec = createSpecWorld(runner);
    await onboardTestEmployee(spec);
    const telegram = new TelegramDriver(spec.world, runner);
    await telegram.start({ chatId: "chat_render", userId: "render_user", inviteCode: "invite_test_1" });
    const consentCallback = telegram.sentMessages()[0]?.replyMarkup?.inlineKeyboard[0]?.[0]?.callbackData;
    await telegram.clickCallback({ chatId: "chat_render", userId: "render_user", callbackData: consentCallback! });
    telegram.clear();

    await telegram.sendText({ chatId: "chat_render", userId: "render_user", text: "Ответь красиво" });

    expect(telegram.sentMessages()).toContainEqual(expect.objectContaining({
      text: "<b>Важно</b>\n• <a href=\"https://example.com\">ссылка</a>\n• <code>код &lt;x&gt;</code>",
      parseMode: "HTML",
    }));
  });
});
