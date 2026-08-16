export const currentPrivacyVersion = "privacy-v3" as const;
export type PrivacyVersion = "privacy-v1" | "privacy-v2" | typeof currentPrivacyVersion;
