import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CheckOptions,
  exitCodeOf,
  formatReport,
  parseEncoders,
  PREPARE_CHECKS,
  type Probes,
  runChecks,
  satisfiesMinimum,
  toJson,
} from "../src/doctor.js";
import { installSkill, skillsDir } from "../src/skill.js";
import { encodeWav, type Pcm } from "../src/tts/wav.js";
import { encodeProjectDir } from "../src/transcript/locate.js";
import { voicevoxAvailable, voicevoxUrl } from "./support.js";

const ENCODERS = [
  "Encoders:",
  " V..... = Video",
  " A..... = Audio",
  " ------",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " A....D aac                  AAC (Advanced Audio Coding)",
  "",
].join("\n");

/** 振幅 0.5 の正弦波(最大音量 約 -6 dBFS) */
function tone(seconds: number, sampleRate = 24_000): Pcm {
  const samples = Int16Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) =>
    Math.round(16384 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)),
  );
  return { sampleRate, channels: 1, samples };
}

/** すべてそろった環境の偽物。overrides で一部を壊す */
function healthy(overrides: Partial<Probes> = {}) {
  const requests: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", path: url.pathname });
    switch (url.pathname) {
      case "/version":
        return Response.json("0.25.2");
      case "/speakers":
        return Response.json([{ name: "ずんだもん", speaker_uuid: "z", styles: [{ name: "ノーマル", id: 3 }] }]);
      case "/initialize_speaker":
        return new Response(null, { status: 204 });
      case "/audio_query":
        return Response.json({ speedScale: 1 });
      case "/synthesis":
        return new Response(new Uint8Array(encodeWav(tone(0.5))));
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  const probes: Partial<Probes> = {
    fetch: fetchImpl,
    nodeVersion: "22.22.0",
    exec: (_command, args) => ({
      status: 0,
      stdout: args.includes("-encoders") ? ENCODERS : "ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers\n",
    }),
    launch: async () => {},
    resolvePackage: (name) => `/node_modules/${name}`,
    writable: async () => {},
    ...overrides,
  };
  return { probes, requests };
}

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

let root: string;
let project: string;
let chrome: string;
let savedConfig: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dopagakix-doctor-"));
  project = path.join(root, "project");
  await mkdir(project);
  chrome = path.join(root, "chrome");
  await writeFile(chrome, "");
  // 利用者の ~/.claude(個人用のスキルやログ)に左右されないようにする
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
});

afterAll(async () => {
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  await rm(root, { recursive: true, force: true });
});

const options = (extra: Partial<CheckOptions> = {}): CheckOptions => ({
  voice: true,
  speaker: 3,
  voicevoxUrl: "http://127.0.0.1:59999",
  persona: "auto",
  chromium: chrome,
  projectDir: project,
  outDir: path.join(project, "dopagakix-out"),
  env: {},
  ...extra,
});

const byId = (results: Awaited<ReturnType<typeof runChecks>>, id: string) => results.find((result) => result.id === id);

describe("runChecks", () => {
  it("すべてそろった環境では、全項目が ok で終了コードは 0", async () => {
    await installSkill({ target: skillsDir({ user: false, projectDir: project }) });
    const logs = path.join(root, "claude", "projects", encodeProjectDir(project));
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");

    const { probes } = healthy();
    const results = await runChecks(
      options({
        synth: true,
        probes,
        env: { CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555" },
        settings: [{ name: "VOICEVOX_URL", value: "http://127.0.0.1:59999", source: "option" }, { name: "TZ", source: "default", unset: "実行環境の設定" }],
      }),
    );
    expect(results.map((result) => result.id)).toEqual([
      "node",
      "dopagakix",
      "ffmpeg",
      "chromium",
      "fonts",
      "voicevox",
      "speaker",
      "synth",
      "skill",
      "transcripts",
      "session",
      "output",
      "settings",
    ]);
    expect(results.filter((result) => result.status !== "ok")).toEqual([]);
    expect(exitCodeOf(results)).toBe(0);
    expect(byId(results, "ffmpeg")?.detail).toBe("ffmpeg version 6.1.1(libx264・aac あり)");
    expect(byId(results, "speaker")?.detail).toBe("ずんだもん(ノーマル、スタイル ID 3)。クレジット表記「VOICEVOX:ずんだもん」。口調: ずんだもん");
    expect(byId(results, "synth")?.detail).toMatch(/^\d+\.\d 秒で合成\(音声 0\.5 秒、最大音量 -6\.0 dBFS\)/);
    expect(byId(results, "transcripts")?.detail).toMatch(/^1 件/);
    expect(byId(results, "session")?.detail).toContain("あり(11111111");
    expect(byId(results, "output")?.detail).toContain("まだありません");
    expect(byId(results, "settings")?.detail).toBe("VOICEVOX_URL: http://127.0.0.1:59999(オプションで指定)\nTZ: 未設定(実行環境の設定)");
  });

  it("足りないものを検出し、対処を示して終了コード 1 にする", async () => {
    const check = async (overrides: Partial<Probes>, extra: Partial<CheckOptions> = {}) => {
      const results = await runChecks(options({ probes: healthy(overrides).probes, ...extra }));
      expect(exitCodeOf(results)).toBe(1);
      return results;
    };

    const noX264 = await check({ exec: (_command, args) => ({ status: 0, stdout: args.includes("-encoders") ? " A....D aac   AAC\n" : "ffmpeg version 7.0\n" }) });
    expect(byId(noX264, "ffmpeg")).toMatchObject({ status: "error", detail: "ffmpeg version 7.0。エンコーダ libx264 がありません", fix: expect.stringContaining("libx264") });

    const noFfmpeg = await check({ exec: () => ({ status: null, stdout: "" }) }, { env: { FFMPEG_PATH: "/opt/ffmpeg" } });
    expect(byId(noFfmpeg, "ffmpeg")).toMatchObject({ status: "error", detail: "/opt/ffmpeg を実行できません" });

    const crashing = await check({
      launch: async () => {
        throw new Error("browserType.launch: error while loading shared libraries: libnss3.so: cannot open shared object file");
      },
    });
    expect(byId(crashing, "chromium")).toMatchObject({ status: "error", fix: "npx playwright-core install --with-deps --only-shell chromium" });

    const missingBrowser = await check({}, { chromium: path.join(root, "no-such-chrome") });
    expect(byId(missingBrowser, "chromium")).toMatchObject({ status: "error", fix: expect.stringContaining("指定したパス") });

    const offline = await check({ fetch: unreachable });
    expect(byId(offline, "voicevox")).toMatchObject({ status: "error", detail: "接続できません(http://127.0.0.1:59999)", fix: expect.stringContaining("docker") });
    // エンジンにつながらなければ、話者は確かめられない(エラーを重ねて数えない)
    expect(byId(offline, "speaker")).toMatchObject({ status: "warn" });

    const wrongSpeaker = await check({}, { speaker: 99 });
    expect(byId(wrongSpeaker, "speaker")).toMatchObject({ status: "error", fix: expect.stringContaining("dopagakix speakers") });

    const oldNode = await check({ nodeVersion: "20.18.0" });
    expect(byId(oldNode, "node")).toMatchObject({ status: "error", detail: "v20.18.0 では動きません(必要: >=22)" });

    const noFonts = await check({
      resolvePackage: (name) => {
        if (name.includes("jetbrains")) throw new Error("not found");
        return name;
      },
    });
    expect(byId(noFonts, "fonts")).toMatchObject({ status: "error", detail: "見つかりません: @fontsource-variable/jetbrains-mono" });

    const readOnly = await check({
      writable: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(byId(readOnly, "output")).toMatchObject({ status: "error", fix: expect.stringContaining("--out-dir") });
  });

  it("導入済みのスキルが同梱版と違えば、エラーではなく注意を出す", async () => {
    const other = path.join(root, "edited");
    await mkdir(other);
    const { dir } = await installSkill({ target: skillsDir({ user: false, projectDir: other }) });
    await writeFile(path.join(dir, "SKILL.md"), "古い版");
    const results = await runChecks(options({ projectDir: other, probes: healthy().probes }));
    expect(byId(results, "skill")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("同梱版と内容が違います(SKILL.md)"),
      fix: "dopagakix install-skill --force",
    });

    const empty = path.join(root, "empty");
    await mkdir(empty);
    const none = await runChecks(options({ projectDir: empty, probes: healthy().probes }));
    expect(byId(none, "skill")).toMatchObject({ status: "warn", fix: expect.stringContaining("dopagakix install-skill") });
    expect(byId(none, "transcripts")).toMatchObject({ status: "warn" });
    expect(exitCodeOf(none)).toBe(0);
  });

  it("何も変更しない(問い合わせは読むだけ、出力先も作らない、エンジンも起動しない)", async () => {
    const { probes, requests } = healthy();
    const outDir = path.join(root, "not-created", "dopagakix-out");
    await runChecks(options({ probes, outDir }));
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(new Set(requests.map((request) => request.path))).toEqual(new Set(["/version", "/speakers"]));
    expect(existsSync(path.join(root, "not-created"))).toBe(false);
  });

  it("--no-voice では読み上げの確認を省く", async () => {
    const results = await runChecks(options({ voice: false, synth: true, probes: healthy({ fetch: unreachable }).probes }));
    expect(results.map((result) => result.group)).not.toContain("読み上げ");
    expect(exitCodeOf(results)).toBe(0);
    expect(formatReport(results, { voice: false })).toContain("## 読み上げ\n- 確認を省きました(--no-voice)");
  });

  it("prepare は描画に必要なものだけを、doctor と同じ判定で確かめる", async () => {
    const extra = { speaker: 99, probes: healthy({ nodeVersion: "20.0.0" }).probes };
    const all = await runChecks(options(extra));
    const prepared = await runChecks(options(extra), PREPARE_CHECKS);
    expect(prepared.map((result) => result.id)).toEqual(["ffmpeg", "chromium", "fonts", "voicevox", "speaker"]);
    expect(prepared).toEqual(all.filter((result) => PREPARE_CHECKS.includes(result.id)));
  });

  it.skipIf(process.platform === "win32")("起動コマンドは prepare が渡したときだけ使う", async () => {
    let calls = 0;
    const starting = (async (input: URL | RequestInfo, init?: RequestInit) =>
      ++calls <= 2 ? unreachable(input, init) : healthy().probes.fetch!(input, init)) as typeof fetch;
    const started: string[] = [];
    const results = await runChecks(
      options({ probes: healthy({ fetch: starting }).probes, startCommand: "exit 0", onStart: (command) => started.push(command) }),
      PREPARE_CHECKS,
    );
    expect(byId(results, "voicevox")).toMatchObject({ status: "ok" });
    expect(started).toEqual(["exit 0"]);
  });
});

describe("出力の形", () => {
  it("--json は項目ごとに id・group・status・detail・fix を出す", async () => {
    const results = await runChecks(options({ probes: healthy({ fetch: unreachable }).probes }));
    const json = JSON.parse(toJson(results)) as Array<Record<string, unknown>>;
    expect(json).toHaveLength(results.length);
    for (const item of json) {
      expect(Object.keys(item)).toEqual(["id", "group", "status", "detail", "fix"]);
      expect(["ok", "warn", "error"]).toContain(item.status);
    }
    expect(json.find((item) => item.id === "voicevox")).toMatchObject({ status: "error", fix: expect.stringContaining("docker") });
    expect(json.find((item) => item.id === "node")).toMatchObject({ status: "ok", fix: null });
  });

  it("人が読む形では、グループごとに並べ、対処と件数を示す", () => {
    const text = formatReport(
      [
        { id: "ffmpeg", group: "描画", name: "ffmpeg", status: "error", detail: "ffmpeg を実行できません", fix: "ffmpeg を入れる" },
        { id: "skill", group: "Claude Code", name: "スキル", status: "warn", detail: "プロジェクト: 違う\n個人用: 同じ" },
      ],
      { voice: true },
    );
    expect(text).toContain("## 描画\n- ffmpeg: [エラー] ffmpeg を実行できません\n  - 対処: ffmpeg を入れる\n");
    expect(text).toContain("## Claude Code\n- スキル: [注意]\n  - プロジェクト: 違う\n  - 個人用: 同じ\n");
    expect(text).toContain("**エラー 1 件、注意 1 件。**");
  });
});

describe("判定の補助", () => {
  it("必要な版(>=)を満たすか", () => {
    expect(satisfiesMinimum("22.0.0", ">=22")).toBe(true);
    expect(satisfiesMinimum("26.1.0", ">=22")).toBe(true);
    expect(satisfiesMinimum("21.9.9", ">=22")).toBe(false);
    expect(satisfiesMinimum("22.4.0", ">=22.5")).toBe(false);
    // 判定できない書き方は満たすとみなす
    expect(satisfiesMinimum("18.0.0", "^22 || ^24")).toBe(true);
  });

  it("ffmpeg -encoders の出力からエンコーダ名を取り出す", () => {
    const encoders = parseEncoders(ENCODERS);
    expect(encoders.has("libx264")).toBe(true);
    expect(encoders.has("aac")).toBe(true);
    expect(encoders.has("Video")).toBe(false);
  });
});

// 実エンジンが動いている環境でだけ実行する
describe.runIf(voicevoxAvailable)("runChecks(実エンジン)", () => {
  it("エンジンの状態(ユーザー辞書を含む)を変えない", async () => {
    const dictionary = async () => (await fetch(new URL("/user_dict", voicevoxUrl))).text();
    const before = await dictionary();
    const results = await runChecks(options({ voicevoxUrl, probes: {} }), ["voicevox", "speaker"]);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(await dictionary()).toBe(before);
  });
});
