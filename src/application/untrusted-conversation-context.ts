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

function escapePromptData(text: string, maxCharacters: number): string {
  return [...text.replace(/\s+/g, " ").trim()]
    .slice(0, maxCharacters)
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
