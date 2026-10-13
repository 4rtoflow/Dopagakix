import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkScript } from "../src/script/check.js";
import { VideoScriptSchema } from "../src/script/schema.js";
import { bundledSkillDir, installSkill, SKILL_NAME, skillsDir } from "../src/skill.js";

const skillFile = path.join(bundledSkillDir(), "SKILL.md");

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
}

describe("同梱のスキル", () => {
  it("名前と説明が Claude Code の読み込める形になっている", async () => {
    const meta = frontmatter(await readFile(skillFile, "utf8"));
    expect(meta.name).toBe(SKILL_NAME);
    expect(path.basename(bundledSkillDir())).toBe(SKILL_NAME);
    // Agent Skills の仕様: 名前は小文字・数字・ハイフンで 64 文字以内、説明は 1024 文字以内
    expect(meta.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    // Claude Code はスキル一覧で description と when_to_use を合わせて 1,536 文字までしか載せない
    expect(meta.description!.length + meta.when_to_use!.length).toBeLessThanOrEqual(1536);
    expect(meta["allowed-tools"]).toBe("Bash(dopagakix *)");
  });

  it("台本の例はスキーマどおりで、check の警告も出ない", async () => {
    const text = await readFile(skillFile, "utf8");
    const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
    const script = VideoScriptSchema.parse(JSON.parse(json!));
    expect(checkScript(script, { seconds: 60 }).issues).toEqual([]);
  });

  it("手順で使うコマンドは CLI に実在する", async () => {
    const text = await readFile(skillFile, "utf8");
    const used = new Set([...text.matchAll(/`dopagakix ([a-z-]+)/g)].map((m) => m[1]));
    const cli = await readFile(path.join(bundledSkillDir(), "..", "..", "..", "src", "cli.ts"), "utf8");
    for (const name of used) expect(cli).toContain(`.command("${name}")`);
    expect([...used].sort()).toEqual(["check", "digest", "prepare", "render", "sessions"]);
  });
});

describe("installSkill", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("導入・同一内容の確認・上書きの確認をする", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dopagakix-skill-"));
    const target = skillsDir({ user: false, projectDir: dir });
    expect(target).toBe(path.join(dir, ".claude", "skills"));

    const first = await installSkill({ target });
    expect(first).toEqual({ dir: path.join(target, SKILL_NAME), status: "installed" });
    expect(await readFile(path.join(first.dir, "SKILL.md"), "utf8")).toBe(await readFile(skillFile, "utf8"));
    expect((await installSkill({ target })).status).toBe("unchanged");

    // 利用者が編集したスキルは、--force なしでは上書きしない
    await writeFile(path.join(first.dir, "SKILL.md"), "edited");
    await writeFile(path.join(first.dir, "notes.md"), "利用者のメモ");
    await expect(installSkill({ target })).rejects.toThrow(/内容の異なるスキル.*SKILL\.md.*--force/);
    expect((await installSkill({ target, force: true })).status).toBe("updated");
    expect(await readFile(path.join(first.dir, "SKILL.md"), "utf8")).toBe(await readFile(skillFile, "utf8"));
    // 同梱していないファイルは消さない
    expect(existsSync(path.join(first.dir, "notes.md"))).toBe(true);
  });

  it("--user では Claude Code の設定ディレクトリに入れる", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
    try {
      expect(skillsDir({ user: true, projectDir: "/somewhere" })).toBe("/tmp/claude-config/skills");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});
