import type { ResponseLengthPreference } from "./employee.js";

export type ResponseChannel = "generic" | "telegram";

export type ResponsePolicy = {
  channel: ResponseChannel;
  preferredLength: ResponseLengthPreference;
  targetCharacters: number;
  maximumBlocks: number;
  overflowStrategy: "summarize_then_offer_continuation_or_artifact";
};

const telegramBudgets: Record<ResponseLengthPreference, Pick<ResponsePolicy, "targetCharacters" | "maximumBlocks">> = {
  short: { targetCharacters: 800, maximumBlocks: 3 },
  balanced: { targetCharacters: 1_200, maximumBlocks: 4 },
  detailed: { targetCharacters: 1_500, maximumBlocks: 5 },
};

export function createResponsePolicy(input: {
  channel?: ResponseChannel;
  preferredLength?: ResponseLengthPreference;
}): ResponsePolicy {
  const channel = input.channel ?? "generic";
  const preferredLength = input.preferredLength ?? "balanced";
  const budget = channel === "telegram"
    ? telegramBudgets[preferredLength]
    : { targetCharacters: 4_000, maximumBlocks: 8 };
  return {
    channel,
    preferredLength,
    ...budget,
    overflowStrategy: "summarize_then_offer_continuation_or_artifact",
  };
}

export function renderResponsePolicy(policy: ResponsePolicy): string {
  return [
    "## Trusted response policy",
    `- Channel: ${policy.channel}`,
    `- Preferred response length: ${policy.preferredLength}`,
    `- Target budget: about ${policy.targetCharacters} Unicode characters; no more than ${policy.maximumBlocks} short blocks.`,
    "- Start with the conclusion or the next practical step; keep paragraphs and lists short.",
    "- If the complete result would exceed the target budget, give a useful summary now and offer continuation in parts or a separate artifact.",
    "- A detailed preference increases the budget, but does not authorize several near-limit transport messages by default.",
  ].join("\n");
}
