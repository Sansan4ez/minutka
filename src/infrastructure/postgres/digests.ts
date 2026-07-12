import { createHmac } from "node:crypto";

/** Deterministic HMAC for indexed secret/transport identity lookup. */
export function keyedDigest(value: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(value, "utf8").digest();
}
