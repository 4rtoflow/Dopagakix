import { existsSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./transcript/locate.js";

export const SKILL_NAME = "video-report";

/** パッケージに同梱しているスキル(dist/ と src/ のどちらから実行しても同じ場所を指す) */
export function bundledSkillDir(): string {
  return fileURLToPath(new URL(`../.claude/skills/${SKILL_NAME}`, import.meta.url));
}

/** スキルの置き場所。プロジェクト単位なら <project>/.claude/skills、個人用なら ~/.claude/skills */
export function skillsDir(scope: { user: boolean; projectDir: string }): string {
  return scope.user ? path.join(claudeConfigDir(), "skills") : path.join(path.resolve(scope.projectDir), ".claude", "skills");
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(dir, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

export interface InstallSkillOptions {
  /** スキルを置くディレクトリ(…/.claude/skills) */
  target: string;
  /** 内容の異なる既存のスキルを上書きする */
  force?: boolean;
  /** 同梱のスキル以外を入れる場合(テスト用) */
  source?: string;
}

export interface InstallSkillResult {
  dir: string;
  status: "installed" | "updated" | "unchanged";
}

/**
 * 導入済みのスキル(dir)のうち、同梱版と内容が違うファイル(無いものを含む)を返す。
 * 同梱していないファイル(利用者が追加したもの)は比べない。
 */
export async function changedSkillFiles(dir: string, source: string = bundledSkillDir()): Promise<string[]> {
  const files = await listFiles(source);
  if (files.length === 0) throw new Error(`同梱のスキルが見つかりません: ${source}`);
  const changed: string[] = [];
  for (const file of files) {
    const current = await readFile(path.join(dir, file)).catch(() => undefined);
    if (!current || !current.equals(await readFile(path.join(source, file)))) changed.push(file);
  }
  return changed;
}

/**
 * スキルを導入する。既にあって内容が異なる場合は、利用者の編集を消さないよう --force を求める。
 * 同梱していないファイル(利用者が追加したもの)は上書き時も消さない。
 */
export async function installSkill(options: InstallSkillOptions): Promise<InstallSkillResult> {
  const source = options.source ?? bundledSkillDir();
  const dir = path.join(options.target, SKILL_NAME);
  if ((await listFiles(source)).length === 0) throw new Error(`同梱のスキルが見つかりません: ${source}`);

  let status: InstallSkillResult["status"] = "installed";
  if (existsSync(dir)) {
    const changed = await changedSkillFiles(dir, source);
    if (changed.length === 0) return { dir, status: "unchanged" };
    if (!options.force) {
      throw new Error(`${dir} に内容の異なるスキルがあります(${changed.join(", ")})。上書きする場合は --force を付けてください。`);
    }
    status = "updated";
  }
  await cp(source, dir, { recursive: true, force: true });
  return { dir, status };
}
