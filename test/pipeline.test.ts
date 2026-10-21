import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertVoiceAllowed, createSynthesizer, excludeOutputs, loadReport, prepareOutputRoot, renderReport } from "../src/pipeline.js";
import { ScriptFileSchema } from "../src/script/schema.js";
import { SilentSynthesizer } from "../src/tts/silent.js";
import type { Synthesizer } from "../src/tts/types.js";
import { VoicevoxSynthesizer } from "../src/tts/voicevox.js";
import { encodeWav, silence } from "../src/tts/wav.js";
import { canRender } from "./support.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(root, "fixtures");
const example = path.join(root, "..", "examples", "script.example.json");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-pipeline-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadReport", () => {
  it("エージェントが書いた台本は、書き手を agent とし、数値は持たない", async () => {
    const script = JSON.parse(await readFile(path.join(fixtures, "script.json"), "utf8"));
    script.work.items = Array.from({ length: 6 }, (_, i) => ` 作業 ${i} `);
    const file = path.join(dir, "report.json");
    await writeFile(file, JSON.stringify(script));

    const report = await loadReport(file);
    expect(report.author).toBe("agent");
    expect(report.facts).toBeUndefined();
    // 確認用には書かれたまま、表示用には上限で切り、空白を整える
    expect(report.raw.work.items).toHaveLength(6);
    expect(report.script.work.items).toEqual(["作業 0", "作業 1", "作業 2", "作業 3", "作業 4"]);
  });

  it("script.json は記録された数値と書き手をそのまま使う", async () => {
    const report = await loadReport(example);
    expect(report.author).toBe("manual");
    expect(report.facts?.files).toHaveLength(2);
  });

  it("JSON の誤りと形式の誤りを、場所が分かるように伝える", async () => {
    const broken = path.join(dir, "broken.json");
    await writeFile(broken, "{ title: ");
    await expect(loadReport(broken)).rejects.toThrow(/JSON として読めません/);

    const missing = path.join(dir, "missing.json");
    const script = JSON.parse(await readFile(path.join(fixtures, "script.json"), "utf8"));
    delete script.next_steps;
    script.status = "done";
    await writeFile(missing, JSON.stringify(script));
    await expect(loadReport(missing)).rejects.toThrow(/形式が正しくありません[\s\S]*status[\s\S]*next_steps/);
  });
});

describe("excludeOutputs", () => {
  it("報告のために書いたファイル(出力先の中)を、変更ファイルの集計から除く", async () => {
    const report = await loadReport(example);
    const file = (p: string) => ({ path: p, added: 1, removed: 0, edits: 1, created: true });
    const facts = {
      ...report.facts!,
      cwd: "/repo",
      files: [file("src/a.ts"), file("dopagakix-out/20261013-x/report.json"), file("reports/run/report.json"), file("/elsewhere/b.ts")],
    };
    expect(excludeOutputs(facts).files.map((f) => f.path)).toEqual(["src/a.ts", "reports/run/report.json", "/elsewhere/b.ts"]);
    expect(excludeOutputs(facts, ["/repo/reports/run"]).files.map((f) => f.path)).toEqual(["src/a.ts", "/elsewhere/b.ts"]);
    // 除くものがなければ同じオブジェクトを返す
    const clean = { ...facts, files: [file("src/a.ts")] };
    expect(excludeOutputs(clean, ["/repo/reports"])).toBe(clean);
  });
});

describe("createSynthesizer", () => {
  const engine = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname === "/speakers") return Response.json([{ name: "ずんだもん", speaker_uuid: "z", styles: [{ name: "ノーマル", id: 3 }] }]);
    if (url.pathname === "/initialize_speaker") return new Response(null, { status: 204 });
    return new Response(new Uint8Array(encodeWav(silence(0.1, 24_000))));
  }) as typeof fetch;
  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const base = { voicevoxUrl: "http://127.0.0.1:59999", speaker: 3 };

  it("VOICEVOX に接続できれば読み上げを使い、できなければエラーにする(字幕のみに切り替えない)", async () => {
    const voiced = await createSynthesizer({ ...base, voice: true, fetch: engine });
    expect(voiced).toBeInstanceOf(VoicevoxSynthesizer);
    expect(voiced.voice).toEqual({ speaker: 3, name: "ずんだもん", style: "ノーマル" });

    await expect(createSynthesizer({ ...base, voice: true, fetch: unreachable })).rejects.toThrow(
      /接続できません[\s\S]*VOICEVOX_URL[\s\S]*DOPAGAKIX_VOICEVOX_START/,
    );

    const credited = await createSynthesizer({ ...base, voice: true, credit: "VOICEVOX:指定した表記", fetch: engine });
    expect(credited.credit).toBe("VOICEVOX:指定した表記");

    // 字幕のみは明示したときだけ
    const silent = await createSynthesizer({ ...base, voice: false, fetch: unreachable });
    expect(silent).toBeInstanceOf(SilentSynthesizer);
    expect(silent.voice).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("起動コマンドが設定されていれば、エンジンを起動してから読み上げを使う", async () => {
    let calls = 0;
    // 話者の一覧と、起動後の最初の応答確認では接続できず、その後は応答する
    const starting = (async (input: URL | RequestInfo, init?: RequestInit) =>
      ++calls <= 2 ? unreachable(input, init) : engine(input, init)) as typeof fetch;
    const started: string[] = [];
    const synth = await createSynthesizer({
      ...base,
      voice: true,
      fetch: starting,
      startCommand: "exit 0",
      onStart: (command) => started.push(command),
    });
    expect(synth).toBeInstanceOf(VoicevoxSynthesizer);
    expect(started).toEqual(["exit 0"]);
  });

  it("話者 ID の誤りはエラーにする", async () => {
    await expect(createSynthesizer({ ...base, speaker: 999, voice: true, fetch: engine })).rejects.toThrow(/話者 ID 999/);
  });
});

describe("assertVoiceAllowed", () => {
  it("DOPAGAKIX_REQUIRE_VOICE=1 のときだけ、字幕のみの指定をエラーにする", () => {
    expect(() => assertVoiceAllowed(false, { DOPAGAKIX_REQUIRE_VOICE: "1" })).toThrow(/DOPAGAKIX_REQUIRE_VOICE=1[\s\S]*--no-voice/);
    expect(() => assertVoiceAllowed(true, { DOPAGAKIX_REQUIRE_VOICE: "1" })).not.toThrow();
    // 読み上げの指定がないコマンド(digest など)
    expect(() => assertVoiceAllowed(undefined, { DOPAGAKIX_REQUIRE_VOICE: "1" })).not.toThrow();
    expect(() => assertVoiceAllowed(false, {})).not.toThrow();
  });
});

describe("renderReport", () => {
  it("読み上げありで音声がほぼ無音なら、動画を作らずにエラーにする", async () => {
    const report = await loadReport(example);
    const workDir = path.join(dir, "silent");
    await prepareOutputRoot(workDir);
    const mute: Synthesizer = {
      credit: "VOICEVOX:テスト",
      voice: { speaker: 3, name: "テスト", style: "ノーマル" },
      synthesize: async () => silence(0.5, 24_000),
    };
    const outFile = path.join(workDir, "summary.mp4");
    await expect(
      renderReport(
        { script: report.script, facts: report.facts!, author: "agent" },
        { outFile, workDir, synth: mute, speed: 1.25, maxSpeed: 1.45, maxSeconds: 120, fps: 4, scale: 0.25 },
      ),
    ).rejects.toThrow(/ほぼ無音です\(完全な無音。-40 dBFS 未満\)/);
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(path.join(workDir, "narration.wav"))).toBe(false);
    // 読み上げの有無と話者を記録する
    const record = ScriptFileSchema.parse(JSON.parse(await readFile(path.join(workDir, "script.json"), "utf8")));
    expect(record.voice).toEqual({ enabled: true, speaker: 3, name: "テスト", style: "ノーマル" });
  });
});

describe("prepareOutputRoot", () => {
  it("出力先の中身を git の管理対象から外し、既存の .gitignore は変えない", async () => {
    const out = path.join(dir, "out");
    await prepareOutputRoot(out);
    expect(await readFile(path.join(out, ".gitignore"), "utf8")).toMatch(/^\*$/m);

    await writeFile(path.join(out, ".gitignore"), "custom\n");
    await prepareOutputRoot(out);
    expect(await readFile(path.join(out, ".gitignore"), "utf8")).toBe("custom\n");
  });
});

describe.runIf(canRender)("renderReport(結合テスト)", () => {
  it("動画と、描画し直すための script.json を書き出す", async () => {
    const report = await loadReport(example);
    const workDir = path.join(dir, "render");
    await prepareOutputRoot(workDir);
    const result = await renderReport(
      { script: report.script, facts: report.facts!, author: "agent", persona: { id: "zundamon", name: "ずんだもん" } },
      {
        outFile: path.join(workDir, "summary.mp4"),
        workDir,
        synth: new SilentSynthesizer(),
        speed: 1.25,
        maxSpeed: 1.45,
        maxSeconds: 120,
        fps: 4,
        scale: 0.25,
        timeZone: "UTC",
      },
    );
    expect(existsSync(result.outFile)).toBe(true);
    expect(existsSync(path.join(workDir, "narration.wav"))).toBe(true);
    const record = ScriptFileSchema.parse(JSON.parse(await readFile(result.scriptFile, "utf8")));
    expect(record).toMatchObject({ author: "agent", persona: { id: "zundamon" }, voice: { enabled: false }, facts: report.facts });

    // 記録した script.json から同じ数値で読み直せる
    const again = await loadReport(result.scriptFile);
    expect(again.facts).toEqual(report.facts);
    expect(again.author).toBe("agent");
  });
});
