export type TelegramVoiceFile = {
  stream: NodeJS.ReadableStream;
  filetype: "ogg";
};

/** Downloads a Telegram voice file without exposing its URL outside the shell. */
export interface TelegramVoiceFileGateway {
  /** The shell aborts this signal when the bounded voice-processing window expires. */
  openVoiceFile(fileId: string, signal?: AbortSignal): Promise<TelegramVoiceFile>;
}
