/** Bound voice download and transcription so a stalled operation cannot retain a chat lock. */
export const voiceProcessingTimeoutMs = 120_000;

export type SpeechToTextInput = {
  /** Audio remains in-process and is never persisted by this port. */
  audio: NodeJS.ReadableStream;
  /** Container format supplied by the transport boundary, for example "ogg". */
  filetype: string;
  /** Cancels the provider request when the voice-processing budget expires. */
  signal?: AbortSignal;
};

/** Transcribes transient audio before it enters the text-only application API. */
export interface SpeechToTextPort {
  transcribe(input: SpeechToTextInput): Promise<string>;
}
