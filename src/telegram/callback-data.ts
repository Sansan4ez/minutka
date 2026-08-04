import type { FeedbackRating } from "../domain/feedback.js";

const ratingMap: Record<FeedbackRating, string> = {
  positive: "p",
  neutral: "n",
  negative: "d",
};

const reverseRatingMap: Record<string, FeedbackRating> = {
  p: "positive",
  n: "neutral",
  d: "negative",
};

export function encodeFeedbackCallbackData(rating: FeedbackRating, targetMessageId: string): string {
  const code = ratingMap[rating];
  if (!code) {
    throw new Error(`Invalid rating: ${rating}`);
  }

  // Validate targetMessageId (ASCII non-whitespace, no ":", <= 50 chars)
  if (!targetMessageId) {
    throw new Error("targetMessageId is empty");
  }
  if (targetMessageId.length > 50) {
    throw new Error("targetMessageId is too long (> 50 chars)");
  }
  if (!/^[\x21-\x7E]+$/.test(targetMessageId)) {
    throw new Error("targetMessageId must be ASCII non-whitespace");
  }
  if (targetMessageId.includes(":")) {
    throw new Error("targetMessageId cannot contain ':'");
  }

  const payload = `fb:${code}:${targetMessageId}`;
  if (Buffer.byteLength(payload, "utf8") > 64) {
    throw new Error("Callback payload exceeds 64 bytes");
  }
  return payload;
}

export type DecodedFeedback = {
  rating: FeedbackRating;
  targetMessageId: string;
};

export type TaskMutationCallbackAction = "confirm" | "reject";
export type DecodedTaskMutation = { action: TaskMutationCallbackAction; confirmationId: string };
export type DecodedPendingActionGroup = { action: TaskMutationCallbackAction; groupId: string };

export function encodePendingActionGroupCallbackData(action: TaskMutationCallbackAction, groupId: string): string {
  if (!/^[\x21-\x7E]+$/.test(groupId) || groupId.includes(":")) throw new Error("groupId must be ASCII non-whitespace without ':'");
  const payload = `gp:${action === "confirm" ? "c" : "r"}:${groupId}`;
  if (Buffer.byteLength(payload, "utf8") > 64) throw new Error("Callback payload exceeds 64 bytes");
  return payload;
}

export function decodePendingActionGroupCallbackData(data: string): DecodedPendingActionGroup | undefined {
  if (Buffer.byteLength(data, "utf8") > 64) return undefined;
  const match = /^gp:([cr]):([^:]+)$/.exec(data);
  if (!match || !/^[\x21-\x7E]+$/.test(match[2]!)) return undefined;
  return { action: match[1] === "c" ? "confirm" : "reject", groupId: match[2]! };
}

export function encodeTaskMutationCallbackData(action: TaskMutationCallbackAction, confirmationId: string): string {
  if (!/^[\x21-\x7E]+$/.test(confirmationId) || confirmationId.includes(":")) throw new Error("confirmationId must be ASCII non-whitespace without ':'");
  const payload = `tm:${action === "confirm" ? "c" : "r"}:${confirmationId}`;
  if (Buffer.byteLength(payload, "utf8") > 64) throw new Error("Callback payload exceeds 64 bytes");
  return payload;
}

export function encodeContextDocumentMutationCallbackData(action: TaskMutationCallbackAction, confirmationId: string): string {
  if (!/^[\x21-\x7E]+$/.test(confirmationId) || confirmationId.includes(":")) throw new Error("confirmationId must be ASCII non-whitespace without ':'");
  const payload = `cd:${action === "confirm" ? "c" : "r"}:${confirmationId}`;
  if (Buffer.byteLength(payload, "utf8") > 64) throw new Error("Callback payload exceeds 64 bytes");
  return payload;
}

export function encodeIdeaDeletionCallbackData(action: TaskMutationCallbackAction, confirmationId: string): string {
  if (!/^[\x21-\x7E]+$/.test(confirmationId) || confirmationId.includes(":")) throw new Error("confirmationId must be ASCII non-whitespace without ':'");
  const payload = `id:${action === "confirm" ? "c" : "r"}:${confirmationId}`;
  if (Buffer.byteLength(payload, "utf8") > 64) throw new Error("Callback payload exceeds 64 bytes");
  return payload;
}

export function decodeContextDocumentMutationCallbackData(data: string): DecodedTaskMutation | undefined {
  if (Buffer.byteLength(data, "utf8") > 64) return undefined;
  const match = /^cd:([cr]):([^:]+)$/.exec(data);
  if (!match || !/^[\x21-\x7E]+$/.test(match[2]!)) return undefined;
  return { action: match[1] === "c" ? "confirm" : "reject", confirmationId: match[2]! };
}

export function decodeIdeaDeletionCallbackData(data: string): DecodedTaskMutation | undefined {
  if (Buffer.byteLength(data, "utf8") > 64) return undefined;
  const match = /^id:([cr]):([^:]+)$/.exec(data);
  if (!match || !/^[\x21-\x7E]+$/.test(match[2]!)) return undefined;
  return { action: match[1] === "c" ? "confirm" : "reject", confirmationId: match[2]! };
}

export function decodeTaskMutationCallbackData(data: string): DecodedTaskMutation | undefined {
  if (Buffer.byteLength(data, "utf8") > 64) return undefined;
  const match = /^tm:([cr]):([^:]+)$/.exec(data);
  if (!match || !/^[\x21-\x7E]+$/.test(match[2]!)) return undefined;
  return { action: match[1] === "c" ? "confirm" : "reject", confirmationId: match[2]! };
}

export function decodeFeedbackCallbackData(data: string): DecodedFeedback | undefined {
  if (Buffer.byteLength(data, "utf8") > 64) {
    return undefined;
  }
  // Format: fb:p|n|d:<targetMessageId>
  if (!data.startsWith("fb:")) {
    return undefined;
  }

  // Find second colon
  const secondColonIndex = data.indexOf(":", 3);
  if (secondColonIndex === -1) {
    return undefined;
  }

  const code = data.substring(3, secondColonIndex);
  const targetMessageId = data.substring(secondColonIndex + 1);

  const rating = reverseRatingMap[code];
  if (!rating) {
    return undefined;
  }

  if (!targetMessageId) {
    return undefined;
  }

  if (targetMessageId.length > 50) {
    return undefined;
  }

  if (!/^[\x21-\x7E]+$/.test(targetMessageId)) {
    return undefined;
  }

  if (targetMessageId.includes(":")) {
    return undefined;
  }

  return { rating, targetMessageId };
}
