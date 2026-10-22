import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = path.join(root, "examples", "script.example.json");
const transcript = path.join(root, "test", "fixtures", "session.jsonl");

/** ソースの CLI を実行する。接続できない VOICEVOX を指定し、起動コマンドと必須化の設定は(env で渡さない限り)外す */
async function run(args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, VOICEVOX_URL: "http://127.0.0.1:59999", ...env };
  for (const name of ["DOPAGAKIX_VOICEVOX_START", "DOPAGAKIX_REQUIRE_VOICE"]) if (!(name in env)) delete base[name];
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: root,
      env: base,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("CLI: 読み上げを必須にする", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-cli-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("render は VOICEVOX に接続できなければ、字幕のみに切り替えずに止まり、mp4 を作らない", async () => {
    const out = path.join(dir, "render", "summary.mp4");
    const result = await run(["render", example, "-o", out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/エラー: VOICEVOX エンジン\(http:\/\/127\.0\.0\.1:59999\)に接続できません/);
    expect(result.stdout).toBe("");
    expect(existsSync(out)).toBe(false);
  });

  it("prepare は VOICEVOX に接続できなければ、不足として知らせて終了コード 1 にする", async () => {
    const result = await run(["prepare", "--transcript", transcript, "--out-dir", path.join(dir, "out")]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/\*\*描画に必要なものが不足しています\([^)]*VOICEVOX ENGINE[^)]*\)。`dopagakix doctor` を実行し/);
    expect(result.stdout).toContain("- VOICEVOX ENGINE: [不足] 接続できません(http://127.0.0.1:59999)");
  });

  it("DOPAGAKIX_REQUIRE_VOICE=1 のとき、--no-voice はエラーにする", async () => {
    const out = path.join(dir, "required", "summary.mp4");
    const result = await run(["render", example, "--no-voice", "-o", out], { DOPAGAKIX_REQUIRE_VOICE: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/エラー: DOPAGAKIX_REQUIRE_VOICE=1 が設定されているため、--no-voice/);
    expect(existsSync(out)).toBe(false);
    // check も同じ
    expect((await run(["check", example, "--no-voice"], { DOPAGAKIX_REQUIRE_VOICE: "1" })).code).toBe(1);
  });
});

describe("CLI: doctor", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-cli-doctor-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("--json で項目ごとの結果を出し、エンジンを起動せずに、エラーがあれば終了コード 1 にする", async () => {
    const marker = path.join(dir, "started");
    const result = await run(["doctor", "--json"], { DOPAGAKIX_VOICEVOX_START: `echo started > '${marker}'` });
    const items = JSON.parse(result.stdout) as Array<{ id: string; status: string; fix: string | null }>;
    expect(items.find((item) => item.id === "voicevox")).toMatchObject({ status: "error", fix: expect.stringContaining("docker") });
    expect(result.code).toBe(1);
    // doctor は何も変更しないため、起動コマンドは実行しない
    expect(existsSync(marker)).toBe(false);
  });

  it("--no-voice は DOPAGAKIX_REQUIRE_VOICE=1 でも使える(確かめるだけで動画を作らないため)", async () => {
    const result = await run(["doctor", "--no-voice", "--json"], { DOPAGAKIX_REQUIRE_VOICE: "1" });
    const items = JSON.parse(result.stdout) as Array<{ id: string; status: string }>;
    expect(items.map((item) => item.id)).not.toContain("voicevox");
    expect(result.code).toBe(items.some((item) => item.status === "error") ? 1 : 0);
  });
});
