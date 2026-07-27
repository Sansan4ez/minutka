import { countUnicodeCharacters, defaultContextBudget, sourceCharacterCeiling, type ContextBudgetConfig } from "./context-budget.js";
import {
  renderAssistantContextSection,
  renderedAssistantContextDocumentCharacters,
  renderedAssistantContextSectionCharacters,
  type AssistantContextDocumentRepresentation,
} from "./assistant-context-renderer.js";
import { contextDocumentHandle, type DocumentStore, type UserDocument, type UserDocumentMetadata } from "./document-store.js";
import { loadContextPriorityManifest, type ContextPriorityManifest } from "./context-priority-manifest.js";
import { renderContextTreeIndex, type ContextTreeIndexDegradationReason, type ContextTreeIndexLevel } from "./context-tree-index.js";

export type ContextProjectionDegradationReason =
  | "per_file_limit"
  | "context_ceiling"
  | "document_limit"
  | ContextTreeIndexDegradationReason;

export type ContextProjectionAudit = {
  sourceId: "context" | "context_index";
  reason: ContextProjectionDegradationReason;
  ceiling: number;
  actualCharacters: number;
  includedCharacters: number;
  documentCount: number;
  affectedCount: number;
};

type ProjectedContextDocument = Pick<UserDocument, "path" | "content" | "version" | "updatedAt"> & {
  representation: AssistantContextDocumentRepresentation;
  originalCharacters: number;
  nextOffset: number | null;
};

export type AssistantContextProjection = {
  schemaVersion: 1;
  path: "/proc/context";
  generatedAt: string;
  scope: { userId: string; requestId: string };
  data: {
    documents: ProjectedContextDocument[];
    truncated: boolean;
    index: { level: ContextTreeIndexLevel; documentCount: number; text: string };
  };
};

export const assistantContextLimits = {
  documents: defaultContextBudget.projectionLimits.contextDocuments,
  characters: sourceCharacterCeiling(defaultContextBudget, "context"),
  documentCharacters: defaultContextBudget.projectionLimits.contextDocumentCharacters,
  indexCharacters: sourceCharacterCeiling(defaultContextBudget, "context_index"),
  indexDepth: defaultContextBudget.projectionLimits.contextIndexDepth,
} as const;

/** Builds the bounded `/proc/context` read model from the owner's context files only. */
export function createAssistantContextProjectionBuilder(deps: { documentStore: DocumentStore; now: () => string; contextBudget?: ContextBudgetConfig; contextPriorities?: ContextPriorityManifest }) {
  const contextPriorities = deps.contextPriorities ?? loadContextPriorityManifest();
  const limits = {
    documents: deps.contextBudget?.projectionLimits.contextDocuments ?? assistantContextLimits.documents,
    characters: sourceCharacterCeiling(deps.contextBudget ?? defaultContextBudget, "context"),
    documentCharacters: deps.contextBudget?.projectionLimits.contextDocumentCharacters ?? assistantContextLimits.documentCharacters,
    indexCharacters: sourceCharacterCeiling(deps.contextBudget ?? defaultContextBudget, "context_index"),
    indexDepth: deps.contextBudget?.projectionLimits.contextIndexDepth ?? assistantContextLimits.indexDepth,
  };
  return {
    async build(input: { userId: string; requestId: string; audit?: (event: ContextProjectionAudit) => void | Promise<void> }): Promise<AssistantContextProjection> {
      const metadata = await deps.documentStore.listMetadata(input.userId, "context/");
      const source = prioritizeContextMetadataWithPolicy(metadata, contextPriorities);
      const index = renderContextTreeIndex({ documents: metadata, ceiling: limits.indexCharacters, depth: limits.indexDepth });
      const audits = new Map<string, ContextProjectionAudit>();
      const documents: AssistantContextProjection["data"]["documents"] = [];

      for (const { metadata: candidate, core } of source) {
        const path = contextDocumentHandle(candidate.path);
        const estimatedCharacters = candidate.size;

        if (core) {
          if (documents.length >= limits.documents) {
            throw new Error(`core context documents exceed the ${limits.documents}-document projection limit`);
          }
          const document = await getRequiredDocument(deps.documentStore, input.userId, candidate.path);
          const actualCharacters = countUnicodeCharacters(document.content);
          const projected = projectedDocument(document, document.content, "full", actualCharacters, null);
          const renderedDocumentCharacters = renderedAssistantContextDocumentCharacters(projected);
          if (renderedDocumentCharacters > limits.documentCharacters) {
            throw new Error(`core context document ${path} renders to ${renderedDocumentCharacters} Unicode characters and exceeds the ${limits.documentCharacters}-character rendered per-file ceiling`);
          }
          const renderedContextCharacters = renderedAssistantContextSectionCharacters({ documents: [...documents, projected], truncated: false });
          if (renderedContextCharacters > limits.characters) {
            throw new Error(`core context documents render to ${renderedContextCharacters} Unicode characters and exceed the ${limits.characters}-character rendered context ceiling`);
          }
          documents.push(projected);
          continue;
        }

        if (documents.length >= limits.documents) {
          aggregateDegradation(audits, degradation("context", "document_limit", limits.documents, estimatedCharacters, 0, source.length, 1));
          continue;
        }

        const reference = projectedMetadata(candidate, renderIndexReference(path, estimatedCharacters, "UTF-8 bytes"), "index-reference", estimatedCharacters, 0);
        const referenceCanFit = canFitContextDocument(documents, reference, limits.characters, true);
        const remainingRenderedCharacters = limits.characters
          - renderedAssistantContextSectionCharacters({ documents, truncated: audits.size > 0 });
        if (!referenceCanFit && estimatedCharacters > remainingRenderedCharacters) {
          aggregateDegradation(audits, degradation("context", "context_ceiling", limits.characters, estimatedCharacters, 0, source.length, 1));
          continue;
        }

        const document = await getRequiredDocument(deps.documentStore, input.userId, candidate.path);
        const contentCharacters = [...document.content];
        const actualCharacters = contentCharacters.length;
        const full = projectedDocument(document, document.content, "full", actualCharacters, null);
        const fullDocumentCharacters = renderedAssistantContextDocumentCharacters(full);
        const fullFits = fullDocumentCharacters <= limits.documentCharacters
          && canFitContextDocument(documents, full, limits.characters, true);
        if (fullFits) {
          documents.push(full);
          continue;
        }

        if (fullDocumentCharacters > limits.documentCharacters) {
          const partial = renderPartialDocument(document, path, contentCharacters, actualCharacters, limits.documentCharacters, documents, limits.characters, true);
          if (partial) {
            documents.push(partial.document);
            aggregateDegradation(audits, degradation("context", "per_file_limit", limits.documentCharacters, actualCharacters, partial.includedCharacters, source.length, 1));
            continue;
          }
        }

        const exactReference = projectedDocument(document, renderIndexReference(path, actualCharacters, "Unicode characters"), "index-reference", actualCharacters, 0);
        const exactReferenceCharacters = renderedAssistantContextDocumentCharacters(exactReference);
        const includedCharacters = canFitContextDocument(documents, exactReference, limits.characters, true)
          ? exactReferenceCharacters
          : 0;
        if (includedCharacters > 0) documents.push(exactReference);
        aggregateDegradation(audits, degradation("context", "context_ceiling", limits.characters, actualCharacters, includedCharacters, source.length, 1));
      }

      if (index.degradation) {
        aggregateDegradation(audits, degradation(
          "context_index",
          index.degradation.reason,
          index.degradation.ceiling,
          index.degradation.actualCharacters,
          countUnicodeCharacters(index.text),
          index.documentCount,
          index.documentCount,
        ));
      }
      const renderedCharacters = renderedAssistantContextSectionCharacters({ documents, truncated: audits.size > 0 });
      if (renderedCharacters > limits.characters) {
        throw new Error(`/proc/context projection renders to ${renderedCharacters} Unicode characters and exceeds the ${limits.characters}-character context source ceiling`);
      }
      for (const event of audits.values()) await input.audit?.(event);

      return {
        schemaVersion: 1,
        path: "/proc/context",
        generatedAt: deps.now(),
        scope: { userId: input.userId, requestId: input.requestId },
        data: { documents, truncated: audits.size > 0, index },
      };
    },
  };
}

/** Context documents are data, not instructions. Fence and escape each document independently. */
export function renderAssistantContextProjection(projection: AssistantContextProjection): string {
  return renderAssistantContextSection(projection.data);
}

export function renderAssistantContextIndex(projection: AssistantContextProjection): string {
  return projection.data.index.text;
}

export function prioritizeContextDocuments(documents: UserDocument[], manifest: ContextPriorityManifest): UserDocument[] {
  return prioritizeContextDocumentsWithPolicy(documents, manifest).map(({ document }) => document);
}

function prioritizeContextDocumentsWithPolicy(documents: UserDocument[], manifest: ContextPriorityManifest): Array<{ document: UserDocument; core: boolean }> {
  return documents
    .map((document, index) => ({ document, index, priority: contextDocumentPriority(document.path, manifest) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ document, priority }) => ({ document, core: priority < manifest.rules.length }));
}

function prioritizeContextMetadataWithPolicy(documents: UserDocumentMetadata[], manifest: ContextPriorityManifest): Array<{ metadata: UserDocumentMetadata; core: boolean }> {
  return documents
    .map((metadata, index) => ({ metadata, index, priority: contextDocumentPriority(metadata.path, manifest) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ metadata, priority }) => ({ metadata, core: priority < manifest.rules.length }));
}

function contextDocumentPriority(path: string, manifest: ContextPriorityManifest): number {
  const handle = contextDocumentHandle(path);
  const coreIndex = manifest.rules.findIndex(({ matcher }) => matcher.test(handle));
  return coreIndex === -1 ? manifest.rules.length : coreIndex;
}

function projectedDocument(document: UserDocument, content: string, representation: ProjectedContextDocument["representation"], originalCharacters: number, nextOffset: number | null): ProjectedContextDocument {
  return { path: contextDocumentHandle(document.path), content, version: document.version, updatedAt: document.updatedAt, representation, originalCharacters, nextOffset };
}

function projectedMetadata(document: UserDocumentMetadata, content: string, representation: ProjectedContextDocument["representation"], originalCharacters: number, nextOffset: number | null): ProjectedContextDocument {
  return { path: contextDocumentHandle(document.path), content, version: document.version, updatedAt: document.updatedAt, representation, originalCharacters, nextOffset };
}

async function getRequiredDocument(documentStore: DocumentStore, userId: string, path: string): Promise<UserDocument> {
  const document = await documentStore.get(userId, path);
  if (!document) throw new Error(`context document disappeared after metadata listing: ${contextDocumentHandle(path)}`);
  return document;
}

function renderPartialDocument(
  document: UserDocument,
  path: string,
  characters: string[],
  originalCharacters: number,
  documentCeiling: number,
  existingDocuments: readonly ProjectedContextDocument[],
  contextCeiling: number,
  truncated: boolean,
): { document: ProjectedContextDocument; includedCharacters: number } | null {
  let low = 1;
  let high = characters.length - 1;
  let selected: { document: ProjectedContextDocument; includedCharacters: number } | null = null;
  while (low <= high) {
    const nextOffset = Math.floor((low + high) / 2);
    const marker = truncationMarker(path, originalCharacters, nextOffset);
    const content = `${characters.slice(0, nextOffset).join("")}\n\n${marker}`;
    const projected = projectedDocument(document, content, "truncated", originalCharacters, nextOffset);
    const renderedCharacters = renderedAssistantContextDocumentCharacters(projected);
    if (renderedCharacters <= documentCeiling && canFitContextDocument(existingDocuments, projected, contextCeiling, truncated)) {
      selected = { document: projected, includedCharacters: renderedCharacters };
      low = nextOffset + 1;
    } else {
      high = nextOffset - 1;
    }
  }
  return selected;
}

function canFitContextDocument(
  documents: readonly ProjectedContextDocument[],
  candidate: ProjectedContextDocument,
  contextCeiling: number,
  truncated: boolean,
): boolean {
  return renderedAssistantContextSectionCharacters({ documents: [...documents, candidate], truncated }) <= contextCeiling;
}

function truncationMarker(path: string, originalCharacters: number, nextOffset: number): string {
  return `[TRUNCATED ${path}: original ${originalCharacters} Unicode characters; continue with readDocument(path="${path}", offset=${nextOffset}).]`;
}

function renderIndexReference(path: string, originalSize: number, unit: "Unicode characters" | "UTF-8 bytes"): string {
  return `[INDEX REFERENCE ${path}: original ${originalSize} ${unit}; read with readDocument(path="${path}").]`;
}

function degradation(sourceId: ContextProjectionAudit["sourceId"], reason: ContextProjectionDegradationReason, ceiling: number, actualCharacters: number, includedCharacters: number, documentCount: number, affectedCount: number): ContextProjectionAudit {
  return { sourceId, reason, ceiling, actualCharacters, includedCharacters, documentCount, affectedCount };
}

function aggregateDegradation(audits: Map<string, ContextProjectionAudit>, event: ContextProjectionAudit): void {
  const key = `${event.sourceId}:${event.reason}:${event.ceiling}`;
  const existing = audits.get(key);
  if (!existing) {
    audits.set(key, event);
    return;
  }
  existing.actualCharacters += event.actualCharacters;
  existing.includedCharacters += event.includedCharacters;
  existing.affectedCount += event.affectedCount;
}
