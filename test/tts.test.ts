import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SilentSynthesizer } from "../src/tts/silent.js";
import { startVoicevox } from "../src/tts/start.js";
import type { Synthesizer } from "../src/tts/types.js";
import { creditFor, VoicevoxError, VoicevoxSynthesizer } from "../src/tts/voicevox.js";
import { durationOf, encodeWav, mixInto, parseWav, peakDbfs, silence } from "../src/tts/wav.js";
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

  it("最大音量を dBFS で求める", () => {
    expect(peakDbfs(silence(1, 10))).toBe(-Infinity);
    expect(peakDbfs({ sampleRate: 10, channels: 1, samples: Int16Array.from([0, -16384, 100]) })).toBeCloseTo(-6.02, 2);
    // -40 dBFS は 32768 の 1/100
    expect(peakDbfs({ sampleRate: 10, channels: 1, samples: Int16Array.from([328]) })).toBeCloseTo(-40, 1);
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
    expect(synth.voice).toEqual({ speaker: 3, name: "ずんだもん", style: "ノーマル" });

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

// 起動コマンドはシェルで実行するため、POSIX のシェルがある環境で確かめる
describe.skipIf(process.platform === "win32")("startVoicevox", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-start-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  /** n 回目の問い合わせから応答するエンジン */
  const respondsFrom = (n: number) => {
    let calls = 0;
    return (async () => (++calls >= n ? Response.json("0.25.2") : unreachable("x"))) as typeof fetch;
  };
  const baseUrl = "http://127.0.0.1:59999";

  it("コマンドを実行し、エンジンが応答するまで待つ", async () => {
    const marker = path.join(dir, "started");
    await startVoicevox({ command: `echo started > '${marker}'`, baseUrl, fetch: respondsFrom(3), intervalMs: 10, logFile: path.join(dir, "a.log") });
    expect(await readFile(marker, "utf8")).toBe("started\n");
  });

  it("エンジンそのもののような終わらないコマンドでも、応答すれば続ける", async () => {
    await expect(
      startVoicevox({ command: "sleep 5", baseUrl, fetch: respondsFrom(2), intervalMs: 10, logFile: path.join(dir, "b.log") }),
    ).resolves.toBeUndefined();
  });

  it("コマンドが失敗したら、終了コードと出力を示してエラーにする", async () => {
    const logFile = path.join(dir, "c.log");
    await expect(
      startVoicevox({ command: "echo no such container >&2; exit 3", baseUrl, fetch: unreachable, intervalMs: 10, logFile }),
    ).rejects.toThrow(/DOPAGAKIX_VOICEVOX_START[\s\S]*終了コード 3[\s\S]*秒待機[\s\S]*no such container/);
    expect(existsSync(logFile)).toBe(true);
  });

  it("応答しないまま時間切れになったら、待った時間を示してエラーにする", async () => {
    await expect(
      startVoicevox({ command: "exit 0", baseUrl, fetch: unreachable, timeoutMs: 200, intervalMs: 20, logFile: path.join(dir, "d.log") }),
    ).rejects.toThrow(/実行して \d+\.\d 秒待ちましたが、エンジン\(http:\/\/127\.0\.0\.1:59999\)が応答しません/);
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
