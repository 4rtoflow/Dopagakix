import type { Pcm } from "./wav.js";

export interface Synthesizer {
  /** 動画に表示するクレジット(例: "VOICEVOX:ずんだもん")。不要なら undefined */
  readonly credit: string | undefined;
  /** speed は話速の倍率(1 が標準) */
  synthesize(text: string, speed: number): Promise<Pcm>;
}
