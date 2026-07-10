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
