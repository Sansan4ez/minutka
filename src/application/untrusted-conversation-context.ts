import type { ConversationTurn } from "./conversation-store.js";

export function renderUntrustedConversationTurns(
  turns: ConversationTurn[],
  options: { maxTurns: number; fieldCharacters: number },
): string {
  return turns
    .slice(-options.maxTurns)
    .map(
      (turn, index) =>
        `<untrusted-turn index="${index + 1}">\n<employee>${escapePromptData(turn.userText, options.fieldCharacters)}</employee>\n<agent>${escapePromptData(turn.agentResponse, options.fieldCharacters)}</agent>\n</untrusted-turn>`,
    )
    .join("\n");
}

export function renderUntrustedCurrentText(text: string, maxCharacters: number): string {
  return `<untrusted-current-employee-text>${escapePromptData(text, maxCharacters)}</untrusted-current-employee-text>`;
}

/** Preserves checkpoint line structure while preventing it from creating prompt structure. */
export function renderUntrustedPreviousThreadSummary(text: string, maxCharacters: number): string {
  const escaped = escapeMultilineUntrustedPromptData(sliceUnicode(text, maxCharacters));
  return `<untrusted-previous-checkpoint>\n${escaped}\n</untrusted-previous-checkpoint>`;
}

/** Quotes multiline untrusted data without allowing XML, headings, or Markdown fences to become prompt structure. */
export function escapeMultilineUntrustedPromptData(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/^([ \t]*)(#+)(?=[ \t]|$)/gm, "$1> $2")
    .replace(/^([ \t]*)(`{3,}|~{3,})/gm, (_match, indentation: string, fence: string) => {
      const escapedMarker = fence[0] === "`" ? "\\u0060" : "\\u007E";
      return `${indentation}${escapedMarker.repeat(fence.length)}`;
    });
}

function escapePromptData(text: string, maxCharacters: number): string {
  return sliceUnicode(text.replace(/\s+/g, " ").trim(), maxCharacters)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sliceUnicode(text: string, maxCharacters: number): string {
  return [...text].slice(0, maxCharacters).join("");
}
