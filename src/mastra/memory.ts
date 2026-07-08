import { Memory } from "@mastra/memory";

export const minutkaMemory = new Memory({
  options: {
    lastMessages: 20,
    generateTitle: false,
  },
});
