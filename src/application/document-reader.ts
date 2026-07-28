import { defaultContextBudget, type ContextBudgetConfig } from "./context-budget.js";
import {
  assertSafeVaultPath,
  contextDocumentHandle,
  type DocumentStore,
  type UserDocument,
  type UserDocumentMetadata,
} from "./document-store.js";

export const documentReadLimits = defaultContextBudget.documentTools;

export type DocumentMetadata = Pick<UserDocumentMetadata, "version" | "updatedAt" | "size"> & {
  path: `/proc/context/${string}`;
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
  totalCharacters: number | null;
  nextOffset: number | null;
  truncated: boolean;
  readBudgetExhausted: boolean;
  scanBudgetExhausted: boolean;
  documentTooLarge: boolean;
  hint: string | null;
};

type SearchDocumentMatchMetadata = Pick<UserDocument, "version" | "updatedAt"> & {
  path: `/proc/context/${string}`;
};

export type SearchDocumentsResult = {
  matches: Array<SearchDocumentMatchMetadata & (
    | { matchedBy: "path"; snippet: null }
    | { matchedBy: "content"; snippet: string }
  )>;
  truncated: boolean;
  readBudgetExhausted: boolean;
  scanBudgetExhausted: boolean;
  documentTooLarge: boolean;
  hint: string | null;
};

export type DocumentToolAudit = (event: {
  operation: "list" | "read" | "search";
  resultCount: number;
  truncated: boolean;
  outcome: "ok" | "not_found";
  path?: string;
  totalCharacters?: number;
  returnedCharacters?: number;
  nextOffset?: number;
  reason?: "ok" | "truncated" | "budget_exhausted" | "scan_budget_exhausted" | "document_too_large";
}) => Promise<void>;

/**
 * Read-only, owner-bound access to the personal context namespace. The owner id
 * is captured by the application and is never accepted from tool input.
 */
export function createOwnerDocumentReader(input: {
  userId: string;
  documentStore: DocumentStore;
  audit?: DocumentToolAudit;
  contextBudget?: ContextBudgetConfig;
}) {
  const limits = input.contextBudget?.documentTools ?? documentReadLimits;
  const audit = async (event: Parameters<DocumentToolAudit>[0]) => input.audit?.(event);
  let returnedContentCharacters = 0;
  let reservedScanBytes = 0;
  const knownTotalCharacters = new Map<string, number>();
  const remainingReadCharacters = () => Math.max(0, limits.turnReadCharacters - returnedContentCharacters);
  const consumeReadCharacters = (characters: number) => { returnedContentCharacters += characters; };
  const remainingScanBytes = () => Math.max(0, limits.turnScanBytes - reservedScanBytes);
  const reserveScanBytes = (bytes: number) => {
    if (bytes > remainingScanBytes()) return false;
    reservedScanBytes += bytes;
    return true;
  };

  return {
    limits,
    async listDocuments(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<ListDocumentsResult> {
      const prefix = storagePrefix(options.prefix);
      const cursor = options.cursor === undefined ? undefined : storagePath(options.cursor);
      const limit = boundedInteger(options.limit, limits.listDefault, 1, limits.listMaximum, "limit");
      const source = (await input.documentStore.listMetadata(input.userId, prefix)).sort((left, right) => compareCodeUnits(left.path, right.path));
      const page = source.filter((document) => cursor === undefined || compareCodeUnits(document.path, cursor) > 0).slice(0, limit + 1);
      const truncated = page.length > limit;
      const selected = page.slice(0, limit);
      const result: ListDocumentsResult = {
        documents: selected.map((document) => ({
          path: contextDocumentHandle(document.path),
          version: document.version,
          updatedAt: document.updatedAt,
          size: document.size,
        })),
        nextCursor: truncated && selected.length > 0 ? contextDocumentHandle(selected[selected.length - 1]!.path) : null,
        truncated,
      };
      await audit({ operation: "list", resultCount: result.documents.length, truncated, outcome: "ok" });
      return result;
    },

    async readDocument(options: { path: string; offset?: number; section?: string; maxCharacters?: number }): Promise<ReadDocumentResult> {
      const path = storagePath(options.path);
      const logicalPath = contextDocumentHandle(path);
      const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
      const requestedMaximum = boundedInteger(options.maxCharacters, limits.readDefaultCharacters, 1, limits.readMaximumCharacters, "maxCharacters");
      const metadata = await input.documentStore.head(input.userId, path);
      if (!metadata) {
        const result = missingReadResult(logicalPath, offset);
        await audit({ operation: "read", resultCount: 0, truncated: false, outcome: "not_found", path: logicalPath, totalCharacters: 0, returnedCharacters: 0, nextOffset: offset, reason: "ok" });
        return result;
      }
      if (remainingReadCharacters() === 0) {
        const result = blockedReadResult(logicalPath, offset, metadata, "readBudgetExhausted", knownTotalCharacters.get(readSelectionKey(path, options.section)));
        await audit({ operation: "read", resultCount: 0, truncated: true, outcome: "ok", path: logicalPath, returnedCharacters: 0, nextOffset: offset, reason: "budget_exhausted" });
        return result;
      }
      if (metadata.size > limits.maximumDocumentBytes) {
        const result = blockedReadResult(logicalPath, offset, metadata, "documentTooLarge");
        await audit({ operation: "read", resultCount: 0, truncated: true, outcome: "ok", path: logicalPath, returnedCharacters: 0, nextOffset: offset, reason: "document_too_large" });
        return result;
      }
      if (!reserveScanBytes(metadata.size)) {
        const result = blockedReadResult(logicalPath, offset, metadata, "scanBudgetExhausted");
        await audit({ operation: "read", resultCount: 0, truncated: true, outcome: "ok", path: logicalPath, returnedCharacters: 0, nextOffset: offset, reason: "scan_budget_exhausted" });
        return result;
      }
      const document = await input.documentStore.get(input.userId, path, metadata);
      if (!document) {
        const result = missingReadResult(logicalPath, offset);
        await audit({ operation: "read", resultCount: 0, truncated: false, outcome: "not_found", path: logicalPath, totalCharacters: 0, returnedCharacters: 0, nextOffset: offset, reason: "ok" });
        return result;
      }
      const selectedContent = options.section === undefined ? document.content : markdownSection(document.content, options.section);
      if (selectedContent === null) {
        const result = { ...missingReadResult(logicalPath, offset), found: true, version: document.version, updatedAt: document.updatedAt };
        await audit({ operation: "read", resultCount: 0, truncated: false, outcome: "not_found", path: logicalPath, totalCharacters: 0, returnedCharacters: 0, nextOffset: offset, reason: "ok" });
        return result;
      }
      const characters = Array.from(selectedContent);
      knownTotalCharacters.set(readSelectionKey(path, options.section), characters.length);
      if (offset >= characters.length) {
        const result: ReadDocumentResult = {
          path: logicalPath, found: true, sectionFound: true, content: "", offset,
          totalCharacters: characters.length, nextOffset: null, truncated: false,
          readBudgetExhausted: false, scanBudgetExhausted: false, documentTooLarge: false,
          hint: null, version: document.version, updatedAt: document.updatedAt,
        };
        await audit({ operation: "read", resultCount: 1, truncated: false, outcome: "ok", path: logicalPath, totalCharacters: characters.length, returnedCharacters: 0, nextOffset: offset, reason: "ok" });
        return result;
      }
      const maximum = Math.min(requestedMaximum, remainingReadCharacters());
      const content = characters.slice(offset, offset + maximum).join("");
      const returnedCharacters = Array.from(content).length;
      consumeReadCharacters(returnedCharacters);
      const nextOffset = offset + returnedCharacters;
      const truncated = nextOffset < characters.length;
      const readBudgetExhausted = truncated && remainingReadCharacters() === 0;
      const result: ReadDocumentResult = {
        path: logicalPath, found: true, sectionFound: true, content, offset,
        totalCharacters: characters.length, nextOffset: truncated ? nextOffset : null, truncated,
        readBudgetExhausted, scanBudgetExhausted: false, documentTooLarge: false,
        hint: readBudgetExhausted ? readBudgetHint : null,
        version: document.version, updatedAt: document.updatedAt,
      };
      await audit({
        operation: "read", resultCount: 1, truncated, outcome: "ok", path: logicalPath,
        totalCharacters: characters.length, returnedCharacters,
        nextOffset: result.nextOffset ?? characters.length,
        reason: readBudgetExhausted ? "budget_exhausted" : truncated ? "truncated" : "ok",
      });
      return result;
    },

    async searchDocuments(options: { query: string; prefix?: string; limit?: number }): Promise<SearchDocumentsResult> {
      const query = options.query.trim();
      if (query.length < 2) throw new Error("query must contain at least 2 characters");
      const prefix = storagePrefix(options.prefix);
      const limit = boundedInteger(options.limit, limits.searchDefault, 1, limits.searchMaximum, "limit");
      const matches: SearchDocumentsResult["matches"] = [];
      const matchAudits: Array<{ path: `/proc/context/${string}`; totalCharacters: number; returnedCharacters: number; nextOffset: number; truncated: boolean }> = [];
      let truncated = false;
      let readBudgetExhausted = remainingReadCharacters() === 0;
      let scanBudgetExhausted = false;
      let documentTooLarge = false;
      const metadata = (await input.documentStore.listMetadata(input.userId, prefix)).sort((left, right) => compareCodeUnits(left.path, right.path));
      for (const item of metadata) {
        if (matches.length === limit) {
          truncated = true;
          break;
        }
        const path = contextDocumentHandle(item.path);
        if (caseInsensitiveIndex(path, query) >= 0) {
          matches.push({ path, matchedBy: "path", snippet: null, version: item.version, updatedAt: item.updatedAt });
          matchAudits.push({ path, totalCharacters: 0, returnedCharacters: 0, nextOffset: 0, truncated: false });
          continue;
        }
        if (readBudgetExhausted) {
          truncated = true;
          continue;
        }
        if (item.size > limits.maximumDocumentBytes) {
          documentTooLarge = true;
          truncated = true;
          continue;
        }
        if (scanBudgetExhausted || !reserveScanBytes(item.size)) {
          scanBudgetExhausted = true;
          truncated = true;
          continue;
        }
        const document = await input.documentStore.get(input.userId, item.path, item);
        if (!document) continue;
        const contentIndex = caseInsensitiveIndex(document.content, query);
        if (contentIndex < 0) continue;
        const snippet = boundedSnippetDetails(document.content, contentIndex, limits.searchSnippetCharacters, remainingReadCharacters());
        consumeReadCharacters(snippet.returnedCharacters);
        matches.push({ path, matchedBy: "content", snippet: snippet.text, version: document.version, updatedAt: document.updatedAt });
        matchAudits.push({ path, ...snippet });
        if (remainingReadCharacters() === 0) {
          readBudgetExhausted = true;
          truncated = true;
        }
      }
      const hint = readBudgetExhausted ? readBudgetHint : scanBudgetExhausted ? scanBudgetHint : documentTooLarge ? documentTooLargeHint : null;
      const result: SearchDocumentsResult = { matches, truncated, readBudgetExhausted, scanBudgetExhausted, documentTooLarge, hint };
      if (matchAudits.length === 0) {
        await audit({
          operation: "search", resultCount: 0, truncated, outcome: "ok", path: logicalSearchPath(prefix),
          totalCharacters: 0, returnedCharacters: 0, nextOffset: 0,
          reason: readBudgetExhausted ? "budget_exhausted" : scanBudgetExhausted ? "scan_budget_exhausted" : documentTooLarge ? "document_too_large" : truncated ? "truncated" : "ok",
        });
      } else {
        for (const [index, match] of matchAudits.entries()) {
          const finalMatch = index === matchAudits.length - 1;
          const resultTruncated = truncated && finalMatch;
          await audit({
            operation: "search", resultCount: 1, truncated: match.truncated || resultTruncated, outcome: "ok",
            path: match.path, totalCharacters: match.totalCharacters, returnedCharacters: match.returnedCharacters, nextOffset: match.nextOffset,
            reason: finalMatch && readBudgetExhausted ? "budget_exhausted"
              : finalMatch && scanBudgetExhausted ? "scan_budget_exhausted"
                : finalMatch && documentTooLarge ? "document_too_large"
                  : match.truncated || resultTruncated ? "truncated" : "ok",
          });
        }
      }
      return result;
    },
  };
}

function storagePrefix(prefix?: string): string {
  const normalized = prefix?.trim().replace(/\/+$/, "");
  if (!normalized || normalized === "/proc/context") return "context/";
  return storagePath(normalized);
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

const readBudgetHint = "Read output budget exhausted; narrow the request with section or search.";
const scanBudgetHint = "Physical scan budget exhausted; narrow the path or search prefix.";
const documentTooLargeHint = "Document exceeds the configured physical byte limit and was not read.";

function missingReadResult(path: `/proc/context/${string}`, offset: number): ReadDocumentResult {
  return {
    path,
    found: false,
    sectionFound: false,
    content: "",
    offset,
    totalCharacters: 0,
    nextOffset: null,
    truncated: false,
    readBudgetExhausted: false,
    scanBudgetExhausted: false,
    documentTooLarge: false,
    hint: null,
    version: "",
    updatedAt: "",
  };
}

function blockedReadResult(
  path: `/proc/context/${string}`,
  offset: number,
  metadata: Pick<UserDocumentMetadata, "version" | "updatedAt">,
  reason: "readBudgetExhausted" | "scanBudgetExhausted" | "documentTooLarge",
  totalCharacters: number | null = null,
): ReadDocumentResult {
  return {
    path,
    found: true,
    sectionFound: false,
    content: "",
    offset,
    totalCharacters,
    nextOffset: offset,
    truncated: true,
    readBudgetExhausted: reason === "readBudgetExhausted",
    scanBudgetExhausted: reason === "scanBudgetExhausted",
    documentTooLarge: reason === "documentTooLarge",
    hint: reason === "readBudgetExhausted" ? readBudgetHint : reason === "scanBudgetExhausted" ? scanBudgetHint : documentTooLargeHint,
    version: metadata.version,
    updatedAt: metadata.updatedAt,
  };
}

function readSelectionKey(path: string, section?: string): string {
  return `${path}\u0000${section?.trim().toLowerCase() ?? ""}`;
}

function markdownSection(content: string, requestedSection: string): string | null {
  const section = requestedSection.trim().toLowerCase();
  if (!section) throw new Error("section must not be empty");
  const headings = markdownHeadings(content);
  const selectedIndex = headings.findIndex((heading) => heading.title.toLowerCase() === section);
  if (selectedIndex < 0) return null;
  const selected = headings[selectedIndex]!;
  const next = headings.slice(selectedIndex + 1).find((heading) => heading.level <= selected.level);
  return content.slice(selected.index, next?.index ?? content.length).trimEnd();
}

function markdownHeadings(content: string): Array<{ index: number; level: number; title: string }> {
  const headings: Array<{ index: number; level: number; title: string }> = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of content.matchAll(/^.*$/gm)) {
    const value = line[0]!;
    if (fence) {
      const closing = value.match(/^[ \t]{0,3}(`+|~+)[ \t]*\r?$/);
      if (closing?.[1]?.[0] === fence.marker && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = value.match(/^[ \t]{0,3}(`{3,}|~{3,})(?:[^\r\n]*)\r?$/);
    if (opening?.[1]) {
      fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
      continue;
    }
    const heading = value.match(/^[ \t]{0,3}(#{1,6})\s+(.+?)\s*#*\s*\r?$/);
    if (heading?.[1] && heading[2]) headings.push({ index: line.index!, level: heading[1].length, title: heading[2].trim() });
  }
  return headings;
}

function caseInsensitiveIndex(value: string, query: string): number {
  const foldedQuery = query.toLowerCase();
  const foldedValue = value.toLowerCase();
  const sourceIndices: number[] = [];
  let sourceIndex = 0;
  for (const character of value) {
    const foldedLength = character.toLowerCase().length;
    for (let index = 0; index < foldedLength; index += 1) sourceIndices.push(sourceIndex);
    sourceIndex += character.length;
  }
  const foldedIndex = foldedValue.indexOf(foldedQuery);
  return foldedIndex < 0 ? -1 : sourceIndices[foldedIndex] ?? value.length;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedSnippetDetails(content: string, matchIndex: number, maximumCharacters: number, budgetCharacters: number): {
  text: string;
  totalCharacters: number;
  returnedCharacters: number;
  nextOffset: number;
  truncated: boolean;
} {
  const characters = Array.from(content);
  const codeUnitPrefix = matchIndex < 0 ? 0 : Array.from(content.slice(0, matchIndex)).length;
  const radius = Math.floor(maximumCharacters / 2);
  let start = Math.max(0, codeUnitPrefix - radius);
  let selected = characters.slice(start, start + maximumCharacters);
  let prefix = start > 0 ? "…" : "";
  let suffix = start + selected.length < characters.length ? "…" : "";
  while (Array.from(`${prefix}${selected.join("")}${suffix}`).length > budgetCharacters && selected.length > 0) {
    selected = selected.slice(0, -1);
    suffix = start + selected.length < characters.length ? "…" : "";
  }
  if (Array.from(`${prefix}${selected.join("")}${suffix}`).length > budgetCharacters) {
    prefix = "";
    suffix = "";
    start = codeUnitPrefix;
  }
  const text = `${prefix}${selected.join("")}${suffix}`;
  return {
    text,
    totalCharacters: characters.length,
    returnedCharacters: Array.from(text).length,
    nextOffset: start + selected.length,
    truncated: start > 0 || start + selected.length < characters.length,
  };
}

function logicalSearchPath(prefix: string): `/proc/context/${string}` {
  const normalized = prefix === "context/" ? "context" : prefix.replace(/\/$/, "");
  return `${normalized === "context" ? "/proc/context/" : contextDocumentHandle(normalized)}` as `/proc/context/${string}`;
}
