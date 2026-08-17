export const currentPrivacyVersion = "privacy-v4" as const;
export type PrivacyVersion = "privacy-v1" | "privacy-v2" | "privacy-v3" | typeof currentPrivacyVersion;
