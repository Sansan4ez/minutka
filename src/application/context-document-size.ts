/** Canonical UTF-8 byte counting rule for context-document writes. */
export function contextDocumentUtf8Bytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/** Returns the exact UTF-8 size or rejects the write before storage is touched. */
export function assertContextDocumentWithinMaximumBytes(input: {
  content: string;
  maximumBytes: number;
  description: string;
}): number {
  const bytes = contextDocumentUtf8Bytes(input.content);
  if (bytes > input.maximumBytes) {
    throw new Error(`${input.description} has ${bytes} UTF-8 bytes and exceeds the ${input.maximumBytes}-byte context document maximum`);
  }
  return bytes;
}
