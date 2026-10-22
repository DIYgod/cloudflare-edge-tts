import { defineConfig } from "cf/config";

export default defineConfig({
  accountId: "1f1d1678a2413a54c944b3081bab5c84",
  worker: {
    name: "cloudflare-edge-tts",
    compatibilityDate: "2026-04-10",
    entrypoint: "src/index.ts",
    workersDev: true,
  },
});
