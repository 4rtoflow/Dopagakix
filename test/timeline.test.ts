import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VideoScriptSchema } from "../src/script/schema.js";
import type { Synthesizer } from "../src/tts/types.js";
import { durationOf, silence } from "../src/tts/wav.js";
import { buildTimeline, splitCaption } from "../src/video/timeline.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const loadScript = async () => VideoScriptSchema.parse(JSON.parse(await readFile(path.join(fixtures, "script.json"), "utf8")));

/** 1 文字 0.2 秒 ÷ 話速 の無音を返す合成器 */
function fakeSynth(): Synthesizer & { speeds: number[] } {
  const speeds: number[] = [];
  return {
    credit: "VOICEVOX:テスト",
    speeds,
    async synthesize(text, speed) {
      speeds.push(speed);
      return silence((text.length * 0.2) / speed, 1000);
    },
  };
}

describe("splitCaption", () => {
  it("短い文はそのまま、長い文は中央に近い句読点で分ける", () => {
    expect(splitCaption("短い文です。")).toEqual(["短い文です。"]);
    const long = "あ".repeat(20) + "、" + "い".repeat(25) + "。";
    expect(splitCaption(long, 38)).toEqual(["あ".repeat(20) + "、", "い".repeat(25) + "。"]);
    expect(splitCaption("う".repeat(50), 38)).toEqual(["う".repeat(25), "う".repeat(25)]);
    expect(splitCaption("   ")).toEqual([]);
  });
});

describe("buildTimeline", () => {
  it("6 シーンを順に並べ、字幕と音声の時刻をそろえる", async () => {
    const synth = fakeSynth();
    const timeline = await buildTimeline(await loadScript(), synth, { maxSeconds: 600, speed: 1, maxSpeed: 1.4 });

    expect(timeline.scenes.map((s) => s.kind)).toEqual([
      "opening",
      "request",
      "work",
      "verification",
      "decisions",
      "closing",
    ]);
    for (const [i, scene] of timeline.scenes.entries()) {
      if (i > 0) expect(scene.start).toBe(timeline.scenes[i - 1]!.end);
      expect(scene.end - scene.start).toBeGreaterThanOrEqual(2.4);
      for (const cue of scene.cues) {
        expect(cue.start).toBeGreaterThanOrEqual(scene.start);
        expect(cue.end).toBeLessThanOrEqual(scene.end);
      }
    }
    const opening = timeline.scenes[0]!.cues[0]!;
    expect(opening.start).toBe(0.5);
    expect(opening.end).toBeCloseTo(0.5 + opening.text.length * 0.2, 3);
    expect(timeline.duration).toBe(timeline.scenes.at(-1)!.end);
    expect(durationOf(timeline.audio)).toBeCloseTo(timeline.duration, 2);
    expect(timeline.credit).toBe("VOICEVOX:テスト");
    expect(new Set(synth.speeds)).toEqual(new Set([1]));
  });

  it("上限を超えると話速を上げて作り直す", async () => {
    const script = await loadScript();
    const relaxed = await buildTimeline(script, fakeSynth(), { maxSeconds: 600, speed: 1, maxSpeed: 1.4 });
    const synth = fakeSynth();
    const limited = await buildTimeline(script, synth, {
      maxSeconds: relaxed.duration - 5,
      speed: 1,
      maxSpeed: 1.4,
    });
    expect(limited.speed).toBeGreaterThan(1);
    expect(limited.speed).toBeLessThanOrEqual(1.4);
    expect(limited.duration).toBeLessThanOrEqual(relaxed.duration - 5 + 0.05);
    expect(synth.speeds).toContain(limited.speed);
  });
});
