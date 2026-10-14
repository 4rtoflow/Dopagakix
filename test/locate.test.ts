import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_SESSION_ENV, encodeProjectDir, listTranscripts, locateTranscript } from "../src/transcript/locate.js";

let root: string;
let project: string;
const saved = { config: process.env.CLAUDE_CONFIG_DIR, session: process.env[CURRENT_SESSION_ENV] };

async function addTranscript(projectDir: string, sessionId: string, minutesAgo: number): Promise<string> {
  const dir = path.join(root, "config", "projects", encodeProjectDir(projectDir));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "user", cwd: projectDir, sessionId })}\n`);
  const time = new Date(Date.now() - minutesAgo * 60_000);
  await utimes(file, time, time);
  return file;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dopagakix-locate-"));
  project = path.join(root, "work", "app");
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(project, "packages", "web"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "config");
  await addTranscript(project, "aaaa1111-old", 30);
  await addTranscript(project, "bbbb2222-new", 1);
  await addTranscript(path.join(root, "elsewhere"), "cccc3333-other", 0);
});

afterEach(() => {
  delete process.env[CURRENT_SESSION_ENV];
});

afterAll(async () => {
  for (const [key, value] of [
    ["CLAUDE_CONFIG_DIR", saved.config],
    [CURRENT_SESSION_ENV, saved.session],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("locateTranscript", () => {
  it("指定がなければプロジェクトの最新のログを使う", async () => {
    delete process.env[CURRENT_SESSION_ENV];
    const found = await locateTranscript({ projectDir: project });
    expect(path.basename(found.file)).toBe("bbbb2222-new.jsonl");
    expect(found.how).toBe("latest");
  });

  it("Claude Code のセッション内で実行されたら、そのセッションのログを使う", async () => {
    process.env[CURRENT_SESSION_ENV] = "aaaa1111-old";
    const found = await locateTranscript({ projectDir: project });
    expect(path.basename(found.file)).toBe("aaaa1111-old.jsonl");
    expect(found.how).toBe("current");

    // 別のプロジェクトのセッションなら使わない
    process.env[CURRENT_SESSION_ENV] = "cccc3333-other";
    expect((await locateTranscript({ projectDir: project })).how).toBe("latest");
  });

  it("サブディレクトリから実行しても、git のルートまでたどって見つける", async () => {
    const found = await locateTranscript({ projectDir: path.join(project, "packages", "web") });
    expect(path.basename(found.file)).toBe("bbbb2222-new.jsonl");
    expect((await listTranscripts(path.join(project, "packages"))).map((t) => t.sessionId)).toEqual([
      "bbbb2222-new",
      "aaaa1111-old",
    ]);
  });

  it("セッション ID の前方一致と、ファイルの直接指定に対応する", async () => {
    const bySession = await locateTranscript({ projectDir: project, session: "aaaa" });
    expect(bySession).toMatchObject({ how: "session" });
    expect(path.basename(bySession.file)).toBe("aaaa1111-old.jsonl");
    // 他のプロジェクトのセッションも ID で指定できる
    expect(path.basename((await locateTranscript({ projectDir: project, session: "cccc" })).file)).toBe("cccc3333-other.jsonl");
    await expect(locateTranscript({ projectDir: project, transcript: path.join(root, "nothing.jsonl") })).rejects.toThrow(
      /見つかりません/,
    );
  });

  it("git の外では親をたどらない", async () => {
    await expect(locateTranscript({ projectDir: path.join(root, "work") })).rejects.toThrow(/--transcript/);
  });
});
