export const currentPrivacyVersion = "privacy-v6" as const;
export type PrivacyVersion = "privacy-v1" | "privacy-v2" | "privacy-v3" | "privacy-v4" | "privacy-v5" | typeof currentPrivacyVersion;
