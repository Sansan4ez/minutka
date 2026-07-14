export type TelegramVoiceFile = {
  stream: NodeJS.ReadableStream;
  filetype: "ogg";
};

/** Downloads a Telegram voice file without exposing its URL outside the shell. */
export interface TelegramVoiceFileGateway {
  openVoiceFile(fileId: string): Promise<TelegramVoiceFile>;
}
