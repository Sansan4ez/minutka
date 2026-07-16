import {
  assertSafeVaultPath,
  contextDocumentHandle,
  type DocumentStore,
  type UserDocument,
} from "./document-store.js";

export const documentReadLimits = {
  listDefault: 20,
  listMaximum: 50,
  readDefaultCharacters: 4_000,
  readMaximumCharacters: 8_000,
  searchDefault: 10,
  searchMaximum: 20,
  searchSnippetCharacters: 500,
} as const;

export type DocumentMetadata = Pick<UserDocument, "version" | "updatedAt"> & {
  path: `/proc/context/${string}`;
  characters: number;
};

export type ListDocumentsResult = {
  documents: DocumentMetadata[];
  nextCursor: string | null;
  truncated: boolean;
};

export type ReadDocumentResult = Pick<UserDocument, "version" | "updatedAt"> & {
  path: `/proc/context/${string}`;
  found: boolean;
  sectionFound: boolean;
  content: string;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
};

export type SearchDocumentsResult = {
  matches: Array<Pick<UserDocument, "version" | "updatedAt"> & {
    path: `/proc/context/${string}`;
    snippet: string;
  }>;
  truncated: boolean;
};

export type DocumentToolAudit = (event: {
  operation: "list" | "read" | "search";
  resultCount: number;
  truncated: boolean;
  outcome: "ok" | "not_found";
}) => Promise<void>;

/**
 * Read-only, owner-bound access to the personal context namespace. The owner id
 * is captured by the application and is never accepted from tool input.
 */
export function createOwnerDocumentReader(input: {
  userId: string;
  documentStore: DocumentStore;
  audit?: DocumentToolAudit;
}) {
  const audit = async (event: Parameters<DocumentToolAudit>[0]) => input.audit?.(event);

  return {
    async listDocuments(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<ListDocumentsResult> {
      const prefix = storagePrefix(options.prefix);
      const cursor = options.cursor === undefined ? undefined : storagePath(options.cursor);
      const limit = boundedInteger(options.limit, documentReadLimits.listDefault, 1, documentReadLimits.listMaximum, "limit");
      const source = await input.documentStore.list(input.userId, prefix);
      const page = source.filter((document) => cursor === undefined || document.path.localeCompare(cursor) > 0).slice(0, limit + 1);
      const truncated = page.length > limit;
      const selected = page.slice(0, limit);
      const result: ListDocumentsResult = {
        documents: selected.map((document) => ({
          path: contextDocumentHandle(document.path),
          version: document.version,
          updatedAt: document.updatedAt,
          characters: Array.from(document.content).length,
        })),
        nextCursor: truncated && selected.length > 0 ? contextDocumentHandle(selected[selected.length - 1]!.path) : null,
        truncated,
      };
      await audit({ operation: "list", resultCount: result.documents.length, truncated, outcome: "ok" });
      return result;
    },

    async readDocument(options: { path: string; offset?: number; section?: string; maxCharacters?: number }): Promise<ReadDocumentResult> {
      const path = storagePath(options.path);
      const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
      const maximum = boundedInteger(options.maxCharacters, documentReadLimits.readDefaultCharacters, 1, documentReadLimits.readMaximumCharacters, "maxCharacters");
      const document = await input.documentStore.get(input.userId, path);
      if (!document) {
        const result = missingReadResult(contextDocumentHandle(path), offset);
        await audit({ operation: "read", resultCount: 0, truncated: false, outcome: "not_found" });
        return result;
      }
      const selectedContent = options.section === undefined ? document.content : markdownSection(document.content, options.section);
      if (selectedContent === null) {
        const result = { ...missingReadResult(contextDocumentHandle(path), offset), found: true, version: document.version, updatedAt: document.updatedAt };
        await audit({ operation: "read", resultCount: 0, truncated: false, outcome: "not_found" });
        return result;
      }
      const characters = Array.from(selectedContent);
      const content = characters.slice(offset, offset + maximum).join("");
      const nextOffset = offset + Array.from(content).length;
      const truncated = nextOffset < characters.length;
      const result: ReadDocumentResult = {
        path: contextDocumentHandle(path),
        found: true,
        sectionFound: true,
        content,
        offset,
        nextOffset: truncated ? nextOffset : null,
        truncated,
        version: document.version,
        updatedAt: document.updatedAt,
      };
      await audit({ operation: "read", resultCount: 1, truncated, outcome: "ok" });
      return result;
    },

    async searchDocuments(options: { query: string; prefix?: string; limit?: number }): Promise<SearchDocumentsResult> {
      const query = options.query.trim();
      if (query.length < 2) throw new Error("query must contain at least 2 characters");
      const prefix = storagePrefix(options.prefix);
      const limit = boundedInteger(options.limit, documentReadLimits.searchDefault, 1, documentReadLimits.searchMaximum, "limit");
      const normalizedQuery = query.toLocaleLowerCase();
      const source = await input.documentStore.list(input.userId, prefix);
      const matches: SearchDocumentsResult["matches"] = [];
      let truncated = false;
      for (const document of source) {
        const path = contextDocumentHandle(document.path);
        const contentIndex = document.content.toLocaleLowerCase().indexOf(normalizedQuery);
        if (contentIndex < 0 && path.toLocaleLowerCase().indexOf(normalizedQuery) < 0) continue;
        if (matches.length === limit) {
          truncated = true;
          break;
        }
        matches.push({
          path,
          snippet: boundedSnippet(document.content, contentIndex),
          version: document.version,
          updatedAt: document.updatedAt,
        });
      }
      const result = { matches, truncated };
      await audit({ operation: "search", resultCount: matches.length, truncated, outcome: "ok" });
      return result;
    },
  };
}

function storagePrefix(prefix?: string): string {
  if (prefix === undefined || prefix.trim().replace(/\/+$/, "") === "/proc/context") return "context/";
  return storagePath(prefix.replace(/\/+$/, ""));
}

function storagePath(path: string): string {
  const normalized = path.trim();
  const agentPrefix = "/proc/context/";
  if (!normalized.startsWith(agentPrefix)) throw new Error(`document path must start with ${agentPrefix}`);
  return assertSafeVaultPath(`context/${normalized.slice(agentPrefix.length)}`, "context/");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return selected;
}

function missingReadResult(path: `/proc/context/${string}`, offset: number): ReadDocumentResult {
  return { path, found: false, sectionFound: false, content: "", offset, nextOffset: null, truncated: false, version: "", updatedAt: "" };
}

function markdownSection(content: string, requestedSection: string): string | null {
  const section = requestedSection.trim().toLocaleLowerCase();
  if (!section) throw new Error("section must not be empty");
  const headings = [...content.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)];
  const selectedIndex = headings.findIndex((match) => match[2]?.trim().toLocaleLowerCase() === section);
  if (selectedIndex < 0) return null;
  const selected = headings[selectedIndex]!;
  const level = selected[1]!.length;
  const next = headings.slice(selectedIndex + 1).find((match) => match[1]!.length <= level);
  return content.slice(selected.index!, next?.index ?? content.length).trimEnd();
}

function boundedSnippet(content: string, matchIndex: number): string {
  const characters = Array.from(content);
  const codeUnitPrefix = matchIndex < 0 ? 0 : Array.from(content.slice(0, matchIndex)).length;
  const radius = Math.floor(documentReadLimits.searchSnippetCharacters / 2);
  const start = Math.max(0, codeUnitPrefix - radius);
  const selected = characters.slice(start, start + documentReadLimits.searchSnippetCharacters).join("");
  return `${start > 0 ? "…" : ""}${selected}${start + Array.from(selected).length < characters.length ? "…" : ""}`;
}
