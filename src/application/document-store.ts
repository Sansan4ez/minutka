export type UserDocument = {
  userId: string;
  /** Logical storage path, for example `context/10_user_memory/goals.md`. */
  path: string;
  content: string;
  version: string;
  updatedAt: string;
};

/** Legacy import prefix retained only for compatibility with already stored objects. */
export const legacyImportedKnowledgeBasePrefix = "context/imported-knowledge-base/";

/**
 * Owner-scoped Markdown documents used as long-lived assistant context.
 * Callers must supply a trusted userId; implementations must not infer it from
 * a path or permit it to be embedded in one.
 */
export type DocumentStore = {
  /** Compatibility read: canonical paths fall back to their legacy alias. */
  get(userId: string, path: string): Promise<UserDocument | null>;
  /** Exact storage read reserved for migrations and collision detection. */
  getExact(userId: string, path: string): Promise<UserDocument | null>;
  /** Exact storage list reserved for migrations; it does not canonicalize aliases. */
  listExact(userId: string, prefix?: string): Promise<UserDocument[]>;
  /** Writes to the canonical logical path, including when passed a legacy alias. */
  put(userId: string, path: string, content: string): Promise<UserDocument>;
  /** Atomically creates a missing logical document and never overwrites canonical or legacy owner content. */
  putIfAbsent(userId: string, path: string, content: string): Promise<UserDocument>;
  list(userId: string, prefix?: string): Promise<UserDocument[]>;
  /** Deletes the logical document together with its known legacy alias. */
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

/** Removes the one known implementation-detail prefix from a storage path. */
export function canonicalDocumentPath(path: string): string {
  const safePath = assertSafeVaultPath(path);
  return safePath.startsWith(legacyImportedKnowledgeBasePrefix)
    ? `context/${safePath.slice(legacyImportedKnowledgeBasePrefix.length)}`
    : safePath;
}

/** Returns the legacy physical alias for a canonical context path, if one exists. */
export function legacyDocumentPath(path: string): string | null {
  const canonicalPath = canonicalDocumentPath(path);
  if (canonicalPath === "context") return legacyImportedKnowledgeBasePrefix.slice(0, -1);
  if (!canonicalPath.startsWith("context/")) return null;
  return `${legacyImportedKnowledgeBasePrefix}${canonicalPath.slice("context/".length)}`;
}

/** Maps a storage path to the stable agent-facing `/proc/context/*` handle. */
export function contextDocumentHandle(path: string): `/proc/context/${string}` {
  const canonicalPath = canonicalDocumentPath(path);
  if (!canonicalPath.startsWith("context/") || canonicalPath === "context/") throw new Error("context document path must start with context/");
  return `/proc/context/${canonicalPath.slice("context/".length)}`;
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
