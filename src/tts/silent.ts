import type { Synthesizer } from "./types.js";
import { type Pcm, silence } from "./wav.js";

/**
 * 音声なし(字幕のみ)用。読み上げた場合とおおよそ同じ長さの無音を返し、字幕の表示時間を決める。
 */
export class SilentSynthesizer implements Synthesizer {
  readonly credit = undefined;

  constructor(
    private readonly charsPerSecond = 6.5,
    private readonly sampleRate = 24_000,
  ) {}

  async synthesize(text: string, speed: number): Promise<Pcm> {
    const seconds = text.length / (this.charsPerSecond * speed) + 0.3;
    return silence(Math.min(9, Math.max(1.4, seconds)), this.sampleRate);
  }
}
