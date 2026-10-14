import { describe, expect, it } from "vitest";
import { canRender, voicevoxAvailable, voicevoxUrl } from "./support.js";

/*
 * 結合テストは、必要な道具がない環境では省略される。CI で環境の準備に失敗したときに
 * テストが省略されたまま成功に見えないよう、環境変数で指定したものは必須にする。
 */
describe("テスト環境", () => {
  it.runIf(process.env.DOPAGAKIX_TEST_REQUIRE_RENDER === "1")("描画の結合テストに必要な Chromium と ffmpeg がある", () => {
    expect(canRender).toBe(true);
  });

  it.runIf(process.env.DOPAGAKIX_TEST_REQUIRE_VOICEVOX === "1")(`VOICEVOX エンジン(${voicevoxUrl})に接続できる`, () => {
    expect(voicevoxAvailable).toBe(true);
  });
});
