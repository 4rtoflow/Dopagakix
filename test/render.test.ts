import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionFacts } from "../src/facts.js";
import { VideoScriptSchema } from "../src/script/schema.js";
import { SilentSynthesizer } from "../src/tts/silent.js";
import { encodeWav } from "../src/tts/wav.js";
import { resolveChromium } from "../src/video/browser.js";
import { renderVideo } from "../src/video/render.js";
import { buildHtml, escapeHtml, shortenPath } from "../src/video/template.js";
import { buildTimeline } from "../src/video/timeline.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const facts: SessionFacts = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  title: "テスト",
  project: "repo",
  branch: "main",
  startTime: "2026-10-01T01:00:00.000Z",
  endTime: "2026-10-01T01:42:00.000Z",
  elapsedMinutes: 42,
  userPrompts: 3,
  toolCalls: 40,
  toolCounts: { Bash: 20 },
  commandsRun: 20,
  commandsFailed: 1,
  files: Array.from({ length: 8 }, (_, i) => ({
    path: `src/very/deep/directory/structure/module-${i}/implementation-file.ts`,
    added: 120 * (i + 1),
    removed: i,
    edits: 1,
    created: i === 0,
  })),
  models: ["claude-opus-5-5"],
};

describe("template helpers", () => {
  it("HTML を無害化し、長いパスの先頭を省く", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(shortenPath("src/a.ts")).toBe("src/a.ts");
    expect(shortenPath("src/very/deep/directory/structure/file.ts", 24)).toBe("…/structure/file.ts");
    expect(shortenPath("x".repeat(50), 20)).toHaveLength(20);
  });
});

function toolAvailable(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

const canRender =
  toolAvailable(() => resolveChromium()) && toolAvailable(() => execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }));

describe.runIf(canRender)("renderVideo(結合テスト)", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("縦長の mp4 を出力し、あふれる内容は縮小して収める", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-test-"));
    const script = VideoScriptSchema.parse(JSON.parse(await readFile(path.join(fixtures, "script.json"), "utf8")));
    script.work.items = Array.from({ length: 5 }, (_, i) => `長い作業項目その${i + 1}。説明が二行に折り返される程度の長さがある`);

    const timeline = await buildTimeline(script, new SilentSynthesizer(), { maxSeconds: 120, speed: 1, maxSpeed: 1.3 });
    const audioFile = path.join(dir, "narration.wav");
    await writeFile(audioFile, encodeWav(timeline.audio));
    const outFile = path.join(dir, "out.mp4");
    const html = buildHtml({ script, facts, scenes: timeline.scenes, credit: "VOICEVOX:テスト", timeZone: "UTC" });

    const stats = await renderVideo(html, { outFile, audioFile, duration: timeline.duration, fps: 8, scale: 0.25 });

    expect(stats.width).toBe(270);
    expect(stats.height).toBe(480);
    expect(stats.captured).toBeLessThan(stats.frames);
    // 作業シーン(5 項目 + 8 ファイル)は収まらないので縮小される
    expect(stats.fitScales[2]).toBeLessThan(1);

    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outFile], { encoding: "utf8" }),
    ) as { streams: Array<Record<string, unknown>>; format: { duration: string } };
    const video = probe.streams.find((s) => s.codec_type === "video")!;
    expect(video).toMatchObject({ codec_name: "h264", width: 270, height: 480, pix_fmt: "yuv420p" });
    expect(probe.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac")).toBe(true);
    expect(Number(probe.format.duration)).toBeCloseTo(timeline.duration, 0);
  });
});
