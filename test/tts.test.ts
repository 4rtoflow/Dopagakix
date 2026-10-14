import { describe, expect, it } from "vitest";
import { SilentSynthesizer } from "../src/tts/silent.js";
import type { Synthesizer } from "../src/tts/types.js";
import { creditFor, VoicevoxError, VoicevoxSynthesizer } from "../src/tts/voicevox.js";
import { durationOf, encodeWav, mixInto, parseWav, silence } from "../src/tts/wav.js";
import { voicevoxAvailable, voicevoxUrl } from "./support.js";

describe("wav", () => {
  it("PCM を書き出して読み戻せる", () => {
    const pcm = { sampleRate: 24_000, channels: 1, samples: Int16Array.from([0, 1000, -1000, 32767, -32768]) };
    const back = parseWav(encodeWav(pcm));
    expect(back.sampleRate).toBe(24_000);
    expect(back.channels).toBe(1);
    expect([...back.samples]).toEqual([0, 1000, -1000, 32767, -32768]);
  });

  it("指定位置に加算合成し、範囲外と飽和を処理する", () => {
    const target = silence(1, 10);
    mixInto(target, { sampleRate: 10, channels: 1, samples: Int16Array.from([30000, 30000, 5]) }, 0.8);
    mixInto(target, { sampleRate: 10, channels: 1, samples: Int16Array.from([10000]) }, 0.8);
    expect([...target.samples.slice(7)]).toEqual([0, 32767, 30000]);
    expect(durationOf(target)).toBe(1);
  });

  it("形式の違う音声は合成しない", () => {
    expect(() => mixInto(silence(1, 24_000), silence(1, 48_000), 0)).toThrow(/形式が一致しません/);
  });
});

describe("SilentSynthesizer", () => {
  it("文字数から表示時間を決め、読み上げの話速には左右されない", async () => {
    const synth: Synthesizer = new SilentSynthesizer(6, 1000);
    const normal = durationOf(await synth.synthesize("あ".repeat(24), 1));
    const fast = durationOf(await synth.synthesize("あ".repeat(24), 2));
    expect(normal).toBeCloseTo(4.4, 2);
    expect(fast).toBe(normal);
    expect(durationOf(await synth.synthesize("短い", 1))).toBe(1.6);
  });
});

describe("creditFor", () => {
  it("規約で書式が決まっている話者以外は「VOICEVOX:話者名」にする", () => {
    expect(creditFor("ずんだもん")).toBe("VOICEVOX:ずんだもん");
    expect(creditFor("Voidoll")).toBe("VOICEVOX:Voidoll(CV:丹下桜)");
    expect(creditFor("ユーレイちゃん")).toBe("VOICEVOX:ユーレイちゃん(CV:神崎零)");
    expect(creditFor("里石ユカ")).toBe("VOICEVOX:里石ユカ（つぼみ）");
  });
});

describe("VoicevoxSynthesizer", () => {
  function fakeEngine() {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      switch (url.pathname) {
        case "/speakers":
          return Response.json([{ name: "ずんだもん", speaker_uuid: "u", styles: [{ name: "ノーマル", id: 3 }] }]);
        case "/initialize_speaker":
          return new Response(null, { status: 204 });
        case "/audio_query":
          return Response.json({ speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1, accent_phrases: [] });
        case "/synthesis":
          return new Response(new Uint8Array(encodeWav(silence(0.5, 24_000))));
        default:
          return new Response("not found", { status: 404 });
      }
    }) as typeof fetch;
    return { requests, fetchImpl };
  }

  it("英単語をカタカナ読みにし、話速を反映して合成する", async () => {
    const { requests, fetchImpl } = fakeEngine();
    const synth = await VoicevoxSynthesizer.create({ speaker: 3, fetch: fetchImpl });
    expect(synth.credit).toBe("VOICEVOX:ずんだもん");

    const pcm = await synth.synthesize("TypeScriptで実装しました。", 1.2);
    expect(durationOf(pcm)).toBeCloseTo(0.5, 3);

    const query = requests.find((r) => r.url.pathname === "/audio_query")!;
    expect(query.url.searchParams.get("enable_katakana_english")).toBe("true");
    expect(query.url.searchParams.get("text")).toBe("TypeScriptで実装しました。");
    const synthesis = requests.find((r) => r.url.pathname === "/synthesis")!;
    expect(JSON.parse(String(synthesis.init?.body))).toMatchObject({ speedScale: 1.2, prePhonemeLength: 0.05 });
  });

  it("音声ライブラリの規約で書式が決まっている話者は、規約どおりのクレジットにする", async () => {
    const engine = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/speakers") return Response.json([{ name: "もち子さん", speaker_uuid: "m", styles: [{ name: "ノーマル", id: 20 }] }]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    expect((await VoicevoxSynthesizer.create({ speaker: 20, fetch: engine })).credit).toBe("VOICEVOX:もち子(cv 明日葉よもぎ)");
    // 規約が変わった場合などに備え、指定で上書きできる
    expect((await VoicevoxSynthesizer.create({ speaker: 20, credit: "VOICEVOX:別表記", fetch: engine })).credit).toBe("VOICEVOX:別表記");
  });

  it("存在しない話者や接続失敗を分かりやすく伝える", async () => {
    const { fetchImpl } = fakeEngine();
    await expect(VoicevoxSynthesizer.create({ speaker: 999, fetch: fetchImpl })).rejects.toThrow(/話者 ID 999/);
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(VoicevoxSynthesizer.create({ fetch: refused })).rejects.toThrow(VoicevoxError);
  });
});

// 実エンジンが動いている環境でだけ実行する
describe.runIf(voicevoxAvailable)("VOICEVOX エンジン(実機)", () => {
  it("日本語の文を音声にできる", async () => {
    const synth = await VoicevoxSynthesizer.create({ baseUrl: voicevoxUrl });
    const pcm = await synth.synthesize("テストは全て成功しました。", 1.15);
    expect(pcm.sampleRate).toBe(24_000);
    expect(durationOf(pcm)).toBeGreaterThan(1);
    expect(pcm.samples.some((s) => Math.abs(s) > 1000)).toBe(true);
  });
});
