import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 描画の結合テストはブラウザと ffmpeg を起動するため長めに取る
    testTimeout: 120_000,
  },
});
