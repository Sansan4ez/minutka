import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const version = 1;
const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;
const headerBytes = 1 + ivBytes + tagBytes;

export type SecretBox = {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
};

export function integrationEncryptionKeyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== keyBytes || key.toString("base64") !== value) {
    throw new Error("INTEGRATION_ENC_KEY must be exactly 32 bytes encoded as canonical base64");
  }
  return key;
}

/** AES-256-GCM envelope: version byte || 12-byte IV || 16-byte tag || ciphertext. */
export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== keyBytes) throw new Error("AES-256-GCM key must be exactly 32 bytes");
  const encryptionKey = Buffer.from(key);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(ivBytes);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(ciphertext) {
      if (ciphertext.length < headerBytes || ciphertext[0] !== version) {
        throw new Error("Unsupported or malformed secret-box ciphertext");
      }
      const iv = ciphertext.subarray(1, 1 + ivBytes);
      const tag = ciphertext.subarray(1 + ivBytes, headerBytes);
      const encrypted = ciphertext.subarray(headerBytes);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    },
  };
}
