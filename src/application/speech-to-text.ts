export type SpeechToTextInput = {
  /** Audio remains in-process and is never persisted by this port. */
  audio: NodeJS.ReadableStream;
  /** Container format supplied by the transport boundary, for example "ogg". */
  filetype: string;
};

/** Transcribes transient audio before it enters the text-only application API. */
export interface SpeechToTextPort {
  transcribe(input: SpeechToTextInput): Promise<string>;
}
