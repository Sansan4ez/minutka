import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSecretBox,
  integrationEncryptionKeyFromBase64,
} from "../../../src/infrastructure/postgres/secret-box.js";
import { postgresConfigFromEnv } from "../../../src/infrastructure/postgres/postgres-config.js";

const key = Buffer.alloc(32, 7);

describe("SECRET-BOX: integration credentials stay encrypted inside Node", () => {
  it("round-trips values and uses a fresh IV for the same plaintext", () => {
    const box = createSecretBox(key);
    const first = box.encrypt("telegram-chat-42");
    const second = box.encrypt("telegram-chat-42");

    expect(first).not.toEqual(second);
    expect(first[0]).toBe(1);
    expect(box.decrypt(first)).toBe("telegram-chat-42");
    expect(box.decrypt(second)).toBe("telegram-chat-42");
  });

  it("rejects authentication-tag damage", () => {
    const box = createSecretBox(key);
    const damaged = Buffer.from(box.encrypt("telegram-chat-42"));
    damaged[13] = damaged[13]! ^ 1;

    expect(() => box.decrypt(damaged)).toThrow();
  });

  it("rejects encryption keys that are not exactly 32 canonical base64 bytes", () => {
    expect(() => integrationEncryptionKeyFromBase64(Buffer.alloc(31).toString("base64"))).toThrow("exactly 32 bytes");
    expect(() => integrationEncryptionKeyFromBase64(`${key.toString("base64")}=`)).toThrow("canonical base64");
    expect(integrationEncryptionKeyFromBase64(key.toString("base64"))).toEqual(key);
  });

  it("requires the separate key before polling startup opens resources", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:5432/personal_assistant",
      DATABASE_SSL_MODE: "disable",
      INVITE_CODE_PEPPER: "invite-pepper",
      TELEGRAM_IDENTITY_PEPPER: "telegram-pepper",
    };
    expect(() => postgresConfigFromEnv({ ...baseEnv, TELEGRAM_MODE: "polling" })).toThrow("TELEGRAM_MODE=polling requires INTEGRATION_ENC_KEY");
    expect(postgresConfigFromEnv({
      ...baseEnv,
      TELEGRAM_MODE: "polling",
      INTEGRATION_ENC_KEY: key.toString("base64"),
    }).integrationEncryptionKey).toEqual(key);
  });

  it("never sends an identity pepper or encryption key through Telegram session SQL", () => {
    const source = readFileSync("src/infrastructure/postgres/postgres-telegram-session-store.ts", "utf8");
    expect(source).not.toMatch(/pgp_sym_|chat_id_encrypted/u);
    expect(source).not.toMatch(/query[\s\S]{0,500}\[[^\]]*\b(?:pepper|secretBox|encryptionKey)\b[^\]]*\]/u);
  });
});
