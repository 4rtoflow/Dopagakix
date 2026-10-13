import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export function claudeConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}
function projectsRoot() {
    return path.join(claudeConfigDir(), "projects");
}
/** Claude Code は、プロジェクトの絶対パスの英数字以外を "-" に置き換えた名前のディレクトリにログを置く。 */
export function encodeProjectDir(dir) {
    return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");
}
async function listJsonl(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl"))
            continue;
        const file = path.join(dir, entry.name);
        const info = await stat(file);
        found.push({ file, sessionId: entry.name.slice(0, -".jsonl".length), modified: info.mtime, size: info.size });
    }
    return found;
}
async function listProjectDirs() {
    const entries = await readdir(projectsRoot(), { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot(), e.name));
}
/** ログの先頭部分だけを読み、記録されている作業ディレクトリ(cwd)を返す。 */
async function readCwd(file) {
    const handle = await open(file, "r");
    try {
        const buffer = Buffer.alloc(256 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.subarray(0, bytesRead).toString("utf8"));
        return match ? JSON.parse(`"${match[1]}"`) : undefined;
    }
    finally {
        await handle.close();
    }
}
const newestFirst = (list) => list.sort((a, b) => b.modified.getTime() - a.modified.getTime());
/**
 * ログを探すディレクトリの候補。エージェントがサブディレクトリに移動してから実行しても
 * 見つかるよう、git のルートまで親をたどる(git の外なら指定したディレクトリだけ)。
 */
function searchDirs(projectDir) {
    const start = path.resolve(projectDir);
    const dirs = [];
    for (let dir = start;; dir = path.dirname(dir)) {
        dirs.push(dir);
        if (existsSync(path.join(dir, ".git")))
            return dirs;
        if (path.dirname(dir) === dir)
            return [start];
    }
}
/** プロジェクトのセッションログを新しい順に返す。 */
export async function listTranscripts(projectDir) {
    const dirs = searchDirs(projectDir);
    for (const dir of dirs) {
        const found = await listJsonl(path.join(projectsRoot(), encodeProjectDir(dir)));
        if (found.length > 0)
            return newestFirst(found);
    }
    // 命名規則が変わった場合に備え、全プロジェクトのログから cwd が一致するものを探す
    const targets = new Set(dirs);
    const found = [];
    for (const dir of await listProjectDirs()) {
        for (const info of await listJsonl(dir)) {
            const cwd = await readCwd(info.file);
            if (cwd && targets.has(cwd))
                found.push(info);
        }
    }
    return newestFirst(found);
}
/**
 * Claude Code が Bash ツールで実行するコマンドに渡す、実行中のセッションの ID
 * (https://code.claude.com/docs/en/env-vars)。Claude Code の外で実行した場合は無いので、最新のログを使う。
 */
export const CURRENT_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
export async function locateTranscript(options) {
    if (options.transcript) {
        if (!existsSync(options.transcript))
            throw new Error(`ログファイルが見つかりません: ${options.transcript}`);
        return { file: path.resolve(options.transcript), how: "path" };
    }
    const candidates = await listTranscripts(options.projectDir);
    if (options.session) {
        const id = options.session;
        const local = candidates.find((t) => t.sessionId.startsWith(id));
        if (local)
            return { file: local.file, how: "session" };
        for (const dir of await listProjectDirs()) {
            const hit = (await listJsonl(dir)).find((t) => t.sessionId.startsWith(id));
            if (hit)
                return { file: hit.file, how: "session" };
        }
        throw new Error(`セッション ${id} のログが見つかりません(${projectsRoot()})`);
    }
    // Claude Code のセッションの中で実行された場合は、そのセッションのログを使う
    const current = process.env[CURRENT_SESSION_ENV];
    const running = current ? candidates.find((t) => t.sessionId === current) : undefined;
    if (running)
        return { file: running.file, how: "current" };
    const latest = candidates[0];
    if (!latest) {
        throw new Error(`${path.resolve(options.projectDir)} のセッションログが ${projectsRoot()} に見つかりません。--transcript でログのパスを指定してください。`);
    }
    return { file: latest.file, how: "latest" };
}
