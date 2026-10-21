import type { Pcm } from "./wav.js";

/** 読み上げに使う話者(script.json に記録する) */
export interface VoiceInfo {
  /** VOICEVOX のスタイル ID */
  speaker: number;
  /** 話者名(例: ずんだもん) */
  name: string;
  /** スタイル名(例: ノーマル) */
  style: string;
}

export interface Synthesizer {
  /** 動画に表示するクレジット(例: "VOICEVOX:ずんだもん")。不要なら undefined */
  readonly credit: string | undefined;
  /** 読み上げる話者。字幕のみ(音声なし)なら undefined */
  readonly voice?: VoiceInfo;
  /** speed は話速の倍率(1 が標準) */
  synthesize(text: string, speed: number): Promise<Pcm>;
}
