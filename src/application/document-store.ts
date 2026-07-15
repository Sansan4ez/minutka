export type UserDocument = {
  userId: string;
  /** Logical vault path, for example `context/01_личная_конституция.md`. */
  path: string;
  content: string;
  version: string;
  updatedAt: string;
};

/**
 * Owner-scoped Markdown documents used as long-lived assistant context.
 * Callers must supply a trusted userId; implementations must not infer it from
 * a path or permit it to be embedded in one.
 */
export type DocumentStore = {
  get(userId: string, path: string): Promise<UserDocument | null>;
  put(userId: string, path: string, content: string): Promise<UserDocument>;
  list(userId: string, prefix?: string): Promise<UserDocument[]>;
  delete(userId: string, path: string): Promise<void>;
};

export function assertSafeVaultPath(path: string, allowedPrefix?: string): string {
  const normalized = path.trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid vault path");
  }
  if (allowedPrefix && !normalized.startsWith(allowedPrefix)) throw new Error(`vault path must start with ${allowedPrefix}`);
  return normalized;
}

export function assertUserId(userId: string): string {
  const normalized = userId.trim();
  // User IDs form the storage isolation boundary and must be one printable
  // segment. This also reserves the NUL separator used by in-memory adapters.
  if (!normalized || normalized === "." || normalized === ".." || /[\\/\u0000-\u001f\u007f]/.test(normalized)) throw new Error("invalid userId");
  return normalized;
}

export function objectKey(userId: string, path: string): string {
  return `${assertUserId(userId)}/${assertSafeVaultPath(path)}`;
}
