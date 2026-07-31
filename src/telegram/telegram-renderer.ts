import { maxTelegramMessageCharacters, telegramMessageLength } from "./telegram-message-limits.js";

export type TelegramParseMode = "HTML";
export type TelegramRenderedChunk = { text: string; parseMode: TelegramParseMode };

type OpenTag = { name: "b" | "i" | "code" | "pre" | "a"; opening: string };

const htmlTokenPattern = /<\/?(?:b|i|code|pre|a)(?: href="[^"]*")?>|&(?:amp|lt|gt|quot);|[\s\S]/gu;
const safeLinkProtocols = new Set(["http:", "https:", "mailto:"]);

export function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safeLinkTarget(rawTarget: string): string | undefined {
  const target = rawTarget.trim();
  if (!target || target.length > 2_048) return undefined;
  try {
    const parsed = new URL(target);
    return safeLinkProtocols.has(parsed.protocol) ? target : undefined;
  } catch {
    return undefined;
  }
}

function closingMarker(text: string, marker: string, start: number): number {
  return text.indexOf(marker, start + marker.length);
}

function renderInlineMarkdown(text: string): string {
  let rendered = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\" && index + 1 < text.length) {
      rendered += escapeTelegramHtml(text[index + 1]!);
      index += 2;
      continue;
    }

    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      const marker = text.slice(index, index + 2);
      const close = closingMarker(text, marker, index);
      if (close === -1) {
        index += marker.length;
        continue;
      }
      const tag = marker === "**" ? "b" : "i";
      rendered += `<${tag}>${renderInlineMarkdown(text.slice(index + marker.length, close))}</${tag}>`;
      index = close + marker.length;
      continue;
    }

    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close === -1) {
        index += 1;
        continue;
      }
      rendered += `<code>${escapeTelegramHtml(text.slice(index + 1, close))}</code>`;
      index = close + 1;
      continue;
    }

    if (text[index] === "[") {
      const labelEnd = text.indexOf("](", index + 1);
      const targetEnd = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2);
      if (labelEnd !== -1 && targetEnd !== -1) {
        const label = renderInlineMarkdown(text.slice(index + 1, labelEnd));
        const rawTarget = text.slice(labelEnd + 2, targetEnd);
        const target = safeLinkTarget(rawTarget);
        rendered += target
          ? `<a href="${escapeTelegramHtml(target)}">${label}</a>`
          : `${label} (${escapeTelegramHtml(rawTarget)})`;
        index = targetEnd + 1;
        continue;
      }
    }

    if (text[index] === "*") {
      const close = closingMarker(text, "*", index);
      if (close === -1) {
        index += 1;
        continue;
      }
      rendered += `<i>${renderInlineMarkdown(text.slice(index + 1, close))}</i>`;
      index = close + 1;
      continue;
    }

    rendered += escapeTelegramHtml(text[index]!);
    index += 1;
  }
  return rendered;
}

export function telegramMarkdownToHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const rendered: string[] = [];
  let codeLines: string[] | undefined;

  for (const line of lines) {
    if (/^\s*```[^`]*$/.test(line)) {
      if (codeLines) {
        rendered.push(`<pre><code>${escapeTelegramHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = undefined;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      rendered.push(`<b>${renderInlineMarkdown(heading[1]!)}</b>`);
      continue;
    }
    const listItem = line.match(/^(\s*)[-+*]\s+(.+)$/);
    if (listItem) {
      rendered.push(`${escapeTelegramHtml(listItem[1]!)}• ${renderInlineMarkdown(listItem[2]!)}`);
      continue;
    }
    rendered.push(renderInlineMarkdown(line));
  }

  if (codeLines) rendered.push(`<pre><code>${escapeTelegramHtml(codeLines.join("\n"))}</code></pre>`);
  return rendered.join("\n");
}

function parseOpeningTag(token: string): OpenTag | undefined {
  const match = token.match(/^<(b|i|code|pre|a)(?: href="[^"]*")?>$/);
  return match ? { name: match[1] as OpenTag["name"], opening: token } : undefined;
}

function parseClosingTag(token: string): OpenTag["name"] | undefined {
  return token.match(/^<\/(b|i|code|pre|a)>$/)?.[1] as OpenTag["name"] | undefined;
}

function stackAfter(stack: OpenTag[], token: string): OpenTag[] {
  const opening = parseOpeningTag(token);
  if (opening) return [...stack, opening];
  const closing = parseClosingTag(token);
  if (!closing) return stack;
  const next = [...stack];
  const matchingIndex = next.map(({ name }) => name).lastIndexOf(closing);
  if (matchingIndex !== -1) next.splice(matchingIndex, 1);
  return next;
}

function closingTags(stack: OpenTag[]): string {
  return [...stack].reverse().map(({ name }) => `</${name}>`).join("");
}

function openingTags(stack: OpenTag[]): string {
  return stack.map(({ opening }) => opening).join("");
}

export function splitTelegramHtml(html: string): string[] {
  if (!html.trim()) return [];
  const tokens = html.match(htmlTokenPattern) ?? [];
  const chunks: string[] = [];
  let stack: OpenTag[] = [];
  let current = "";
  let hasContent = false;

  for (const token of tokens) {
    const nextStack = stackAfter(stack, token);
    const projected = `${current}${token}${closingTags(nextStack)}`;
    if (hasContent && telegramMessageLength(projected) > maxTelegramMessageCharacters) {
      chunks.push(`${current}${closingTags(stack)}`);
      current = openingTags(stack);
      hasContent = false;
    }

    current += token;
    stack = nextStack;
    if (!parseOpeningTag(token) && !parseClosingTag(token)) hasContent = true;
  }

  if (hasContent || current) chunks.push(`${current}${closingTags(stack)}`);
  return chunks.filter((chunk) => chunk.length > 0);
}

function renderChunks(html: string): TelegramRenderedChunk[] {
  return splitTelegramHtml(html).map((text) => ({ text, parseMode: "HTML" }));
}

export function renderTelegramPlainText(text: string): TelegramRenderedChunk[] {
  return renderChunks(escapeTelegramHtml(text.trim()));
}

export function renderTelegramMarkdown(markdown: string): TelegramRenderedChunk[] {
  return renderChunks(telegramMarkdownToHtml(markdown.trim()));
}
