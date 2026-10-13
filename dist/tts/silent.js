import { silence } from "./wav.js";
/**
 * 音声なし(字幕のみ)用。字幕を読み切れる長さの無音を返し、字幕の表示時間を決める。
 * 黙読の速さは読み上げの話速と関係ないため、speed は使わない。
 */
export class SilentSynthesizer {
    charsPerSecond;
    sampleRate;
    credit = undefined;
    constructor(charsPerSecond = 6, sampleRate = 24_000) {
        this.charsPerSecond = charsPerSecond;
        this.sampleRate = sampleRate;
    }
    async synthesize(text) {
        const seconds = text.length / this.charsPerSecond + 0.4;
        return silence(Math.min(9, Math.max(1.6, seconds)), this.sampleRate);
    }
}
