import { execFileSync } from "node:child_process";
import { DEFAULT_VOICEVOX_URL } from "../src/tts/voicevox.js";
import { resolveChromium } from "../src/video/browser.js";

/*
 * 結合テストに使う外部の道具(Chromium・ffmpeg・VOICEVOX)がそろっているかを調べる。
 * そろっていなければ結合テストは省略するが、CI では省略を許さない(environment.test.ts)。
 */

function available(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/** 描画の結合テストを実行できるか */
export const canRender =
  available(() => resolveChromium()) &&
  available(() => execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"], { stdio: "ignore" }));

export const voicevoxUrl = process.env.VOICEVOX_URL ?? DEFAULT_VOICEVOX_URL;

/** VOICEVOX ENGINE が動いているか(例: docker run -p 50021:50021 voicevox/voicevox_engine:cpu-latest) */
export const voicevoxAvailable = await fetch(new URL("/version", voicevoxUrl), { signal: AbortSignal.timeout(1000) })
  .then((response) => response.ok)
  .catch(() => false);
