import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function projectsRoot(): string {
  return path.join(claudeConfigDir(), "projects");
}

/** Claude Code は、プロジェクトの絶対パスの英数字以外を "-" に置き換えた名前のディレクトリにログを置く。 */
export function encodeProjectDir(dir: string): string {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");
}

export interface TranscriptInfo {
  file: string;
  sessionId: string;
  modified: Date;
  size: number;
}

async function listJsonl(dir: string): Promise<TranscriptInfo[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: TranscriptInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name);
    const info = await stat(file);
    found.push({ file, sessionId: entry.name.slice(0, -".jsonl".length), modified: info.mtime, size: info.size });
  }
  return found;
}

async function listProjectDirs(): Promise<string[]> {
  const entries = await readdir(projectsRoot(), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot(), e.name));
}

/** ログの先頭部分だけを読み、記録されている作業ディレクトリ(cwd)を返す。 */
async function readCwd(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.subarray(0, bytesRead).toString("utf8"));
    return match ? (JSON.parse(`"${match[1]}"`) as string) : undefined;
  } finally {
    await handle.close();
  }
}

/** プロジェクトのセッションログを新しい順に返す。 */
export async function listTranscripts(projectDir: string): Promise<TranscriptInfo[]> {
  const target = path.resolve(projectDir);
  const found = await listJsonl(path.join(projectsRoot(), encodeProjectDir(target)));
  if (found.length === 0) {
    // 命名規則が変わった場合に備え、全プロジェクトのログから cwd が一致するものを探す
    for (const dir of await listProjectDirs()) {
      for (const info of await listJsonl(dir)) {
        if ((await readCwd(info.file)) === target) found.push(info);
      }
    }
  }
  return found.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export interface LocateOptions {
  /** ログファイルのパス(指定があれば最優先) */
  transcript?: string;
  /** セッション ID(前方一致可) */
  session?: string;
  /** 最新のログを探すプロジェクトのディレクトリ */
  projectDir: string;
}

export async function locateTranscript(options: LocateOptions): Promise<string> {
  if (options.transcript) {
    if (!existsSync(options.transcript)) throw new Error(`ログファイルが見つかりません: ${options.transcript}`);
    return path.resolve(options.transcript);
  }

  const candidates = await listTranscripts(options.projectDir);
  if (options.session) {
    const id = options.session;
    const local = candidates.find((t) => t.sessionId.startsWith(id));
    if (local) return local.file;
    for (const dir of await listProjectDirs()) {
      const hit = (await listJsonl(dir)).find((t) => t.sessionId.startsWith(id));
      if (hit) return hit.file;
    }
    throw new Error(`セッション ${id} のログが見つかりません(${projectsRoot()})`);
  }

  const latest = candidates[0];
  if (!latest) {
    throw new Error(
      `${path.resolve(options.projectDir)} のセッションログが ${projectsRoot()} に見つかりません。ログのパスを直接指定してください。`,
    );
  }
  return latest.file;
}
