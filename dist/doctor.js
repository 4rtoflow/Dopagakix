import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolvePersona } from "./persona.js";
import { SILENT_DBFS } from "./pipeline.js";
import { changedSkillFiles, SKILL_NAME, skillsDir } from "./skill.js";
import { CURRENT_SESSION_ENV, claudeConfigDir, listTranscripts } from "./transcript/locate.js";
import { withVoicevoxStart } from "./tts/start.js";
import { creditFor, VoicevoxClient, VoicevoxConnectionError, VoicevoxSynthesizer } from "./tts/voicevox.js";
import { durationOf, peakDbfs } from "./tts/wav.js";
import { formatDateTime } from "./util/time.js";
import { resolveChromium } from "./video/browser.js";
import { FONT_PACKAGES, packageDir } from "./video/render.js";
export const GROUPS = ["実行環境", "描画", "読み上げ", "Claude Code", "出力", "設定"];
const defaultProbes = {
    fetch: (...args) => fetch(...args),
    nodeVersion: process.versions.node,
    exec: (command, args) => {
        const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
    },
    launch: async (executablePath) => {
        const browser = await chromium.launch({ executablePath, timeout: 30_000 });
        await browser.close();
    },
    resolvePackage: packageDir,
    writable: (dir) => access(dir, constants.W_OK),
};
const { version, engines } = createRequire(import.meta.url)("../package.json");
/** "1.2.3" が ">=1.2" を満たすか。">=" 以外の書き方は判定せず満たすとみなす */
export function satisfiesMinimum(actual, range) {
    const minimum = /^>=\s*v?(\d+(?:\.\d+){0,2})$/.exec(range.trim())?.[1];
    if (!minimum)
        return true;
    const a = actual.replace(/^v/, "").split(".").map(Number);
    const b = minimum.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0)
            return diff > 0;
    }
    return true;
}
/** ffmpeg -encoders の出力から、エンコーダ名の一覧を取り出す */
export function parseEncoders(output) {
    return new Set([...output.matchAll(/^ [VAS][A-Z.]{5} (\S+)/gm)].map((m) => m[1]));
}
const firstLine = (text) => text.trim().split("\n")[0].trim();
const FFMPEG_FIX = "libx264 と aac のエンコーダを含む ffmpeg を入れてください(例: Ubuntu は sudo apt-get install ffmpeg、macOS は brew install ffmpeg)";
const CHROMIUM_FIX = "npx playwright-core install --only-shell chromium";
/** パスを指定している場合は、まずその指定を疑う */
const chromiumFix = (explicit, fix) => explicit ? `指定したパス(--chromium または DOPAGAKIX_CHROMIUM)を確かめてください。指定しない場合は ${fix} で入れたものを使います` : fix;
const ENGINE_FIX = "VOICEVOX ENGINE を起動してください(Docker なら docker run -d --name voicevox -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest、" +
    "作成済みのコンテナなら docker start voicevox)。別の場所のエンジンを使う場合は VOICEVOX_URL を設定します";
const UNVERIFIED = { status: "warn", detail: "確かめていません(VOICEVOX ENGINE に接続できないため)" };
export const CHECKS = [
    {
        id: "node",
        group: "実行環境",
        name: "Node.js",
        run: async ({ probes }) => {
            const required = engines?.node ?? ">=22";
            return satisfiesMinimum(probes.nodeVersion, required)
                ? { status: "ok", detail: `v${probes.nodeVersion}(必要: ${required})` }
                : { status: "error", detail: `v${probes.nodeVersion} では動きません(必要: ${required})`, fix: "Node.js を更新してください(https://nodejs.org/)" };
        },
    },
    {
        id: "dopagakix",
        group: "実行環境",
        name: "dopagakix",
        run: async () => ({ status: "ok", detail: `${version}(${path.resolve(fileURLToPath(new URL("..", import.meta.url)))})` }),
    },
    {
        id: "ffmpeg",
        group: "描画",
        name: "ffmpeg",
        run: async ({ env, probes }) => {
            const ffmpeg = env.FFMPEG_PATH ?? "ffmpeg";
            const versionOutput = probes.exec(ffmpeg, ["-hide_banner", "-version"]);
            if (versionOutput.status !== 0)
                return { status: "error", detail: `${ffmpeg} を実行できません`, fix: FFMPEG_FIX };
            const name = firstLine(versionOutput.stdout).replace(/\s+Copyright.*$/, "");
            const encoders = parseEncoders(probes.exec(ffmpeg, ["-hide_banner", "-encoders"]).stdout);
            const lacking = ["libx264", "aac"].filter((encoder) => !encoders.has(encoder));
            return lacking.length > 0
                ? { status: "error", detail: `${name}。エンコーダ ${lacking.join("・")} がありません`, fix: FFMPEG_FIX }
                : { status: "ok", detail: `${name}(libx264・aac あり)` };
        },
    },
    {
        id: "chromium",
        group: "描画",
        name: "Chromium",
        run: async ({ options, env, probes }) => {
            const explicit = options.chromium ?? env.DOPAGAKIX_CHROMIUM;
            let executable;
            try {
                executable = resolveChromium(explicit);
            }
            catch (error) {
                return { status: "error", detail: error.message, fix: chromiumFix(explicit, CHROMIUM_FIX) };
            }
            try {
                await probes.launch(executable);
            }
            catch (error) {
                const message = firstLine(error.message);
                // Linux で共有ライブラリが足りない場合は、依存パッケージごと入れる
                const libraries = /shared librar|shared object/i.test(error.message);
                return {
                    status: "error",
                    detail: `${executable} を起動できません: ${message}`,
                    fix: libraries ? "npx playwright-core install --with-deps --only-shell chromium" : chromiumFix(explicit, CHROMIUM_FIX),
                };
            }
            return { status: "ok", detail: `${executable}(起動できます)` };
        },
    },
    {
        id: "fonts",
        group: "描画",
        name: "フォント",
        run: async ({ probes }) => {
            const missing = Object.values(FONT_PACKAGES).filter((name) => {
                try {
                    probes.resolvePackage(name);
                    return false;
                }
                catch {
                    return true;
                }
            });
            return missing.length > 0
                ? { status: "error", detail: `見つかりません: ${missing.join("、")}`, fix: "dopagakix を入れ直してください(npm install -g github:4rtoflow/Dopagakix)" }
                : { status: "ok", detail: "Noto Serif JP・Zen Kaku Gothic New・JetBrains Mono" };
        },
    },
    {
        id: "voicevox",
        group: "読み上げ",
        name: "VOICEVOX ENGINE",
        enabled: (options) => options.voice,
        run: async ({ options, engine }) => {
            const { version: engineVersion, error } = await engine();
            if (!error)
                return { status: "ok", detail: `${engineVersion}(${options.voicevoxUrl})` };
            const detail = error instanceof VoicevoxConnectionError ? `接続できません(${options.voicevoxUrl})` : error.message;
            return { status: "error", detail, fix: ENGINE_FIX };
        },
    },
    {
        id: "speaker",
        group: "読み上げ",
        name: "話者",
        enabled: (options) => options.voice,
        run: async ({ options, probes, engine }) => {
            const { speakers } = await engine();
            if (!speakers)
                return UNVERIFIED;
            const owner = speakers.find((s) => s.styles.some((style) => style.id === options.speaker));
            const style = owner?.styles.find((s) => s.id === options.speaker);
            if (!owner || !style) {
                return {
                    status: "error",
                    detail: `スタイル ID ${options.speaker} がエンジンにありません`,
                    fix: "dopagakix speakers で一覧を確かめ、--speaker か DOPAGAKIX_SPEAKER で指定してください",
                };
            }
            const speech = `${owner.name}(${style.name}、スタイル ID ${options.speaker})。クレジット表記「${options.credit ?? creditFor(owner.name)}」`;
            try {
                const persona = await resolvePersona({
                    option: options.persona,
                    speaker: options.speaker,
                    voice: true,
                    voicevoxUrl: options.voicevoxUrl,
                    fetch: probes.fetch,
                });
                return { status: "ok", detail: `${speech}。口調: ${persona?.name ?? "丁寧語"}` };
            }
            catch (error) {
                return { status: "error", detail: `${speech}。口調: ${error.message}`, fix: "--persona か DOPAGAKIX_PERSONA を確かめてください" };
            }
        },
    },
    {
        id: "synth",
        group: "読み上げ",
        name: "合成",
        enabled: (options) => options.voice && Boolean(options.synth),
        run: async ({ options, probes, engine }) => {
            if ((await engine()).error)
                return UNVERIFIED;
            const seconds = (from) => ((performance.now() - from) / 1000).toFixed(1);
            try {
                const prepared = performance.now();
                const synth = await VoicevoxSynthesizer.create({
                    baseUrl: options.voicevoxUrl,
                    speaker: options.speaker,
                    credit: options.credit,
                    fetch: probes.fetch,
                });
                const preparing = seconds(prepared);
                const started = performance.now();
                const pcm = await synth.synthesize("動作確認のための読み上げです。", 1.25);
                const synthesizing = seconds(started);
                const peak = peakDbfs(pcm);
                const level = Number.isFinite(peak) ? `最大音量 ${peak.toFixed(1)} dBFS` : "完全な無音";
                return peak < SILENT_DBFS
                    ? { status: "error", detail: `合成した音声がほぼ無音です(${level})`, fix: "VOICEVOX ENGINE のログを確かめ、起動し直してください" }
                    : {
                        status: "ok",
                        // 話者の準備(モデルの読み込み)は、エンジンの起動後に初めて使う話者だけ時間がかかる
                        detail: `${synthesizing} 秒で合成(音声 ${durationOf(pcm).toFixed(1)} 秒、${level})。話者の準備 ${preparing} 秒`,
                    };
            }
            catch (error) {
                return { status: "error", detail: `合成できません: ${error.message}`, fix: "VOICEVOX ENGINE のログを確かめ、起動し直してください" };
            }
        },
    },
    {
        id: "skill",
        group: "Claude Code",
        name: "スキル",
        run: async ({ options }) => {
            const places = [
                { label: "プロジェクト", dir: path.join(skillsDir({ user: false, projectDir: options.projectDir }), SKILL_NAME), flag: "" },
                { label: "個人用", dir: path.join(skillsDir({ user: true, projectDir: options.projectDir }), SKILL_NAME), flag: " --user" },
            ];
            const installed = places.filter((place) => existsSync(place.dir));
            if (installed.length === 0) {
                return {
                    status: "warn",
                    detail: `導入されていません(プロジェクト: ${places[0].dir}、個人用: ${places[1].dir})`,
                    fix: "dopagakix install-skill(すべてのプロジェクトで使う場合は --user を付ける)",
                };
            }
            const lines = [];
            const fixes = [];
            for (const place of installed) {
                const changed = await changedSkillFiles(place.dir);
                if (changed.length === 0) {
                    lines.push(`${place.label}: 同梱版と同じ(${place.dir})`);
                }
                else {
                    lines.push(`${place.label}: 同梱版と内容が違います(${changed.join(", ")})。古い可能性があります。意図して編集している場合はそのままで構いません(${place.dir})`);
                    fixes.push(`dopagakix install-skill${place.flag} --force`);
                }
            }
            return { status: fixes.length > 0 ? "warn" : "ok", detail: lines.join("\n"), ...(fixes.length > 0 ? { fix: fixes.join(" / ") } : {}) };
        },
    },
    {
        id: "transcripts",
        group: "Claude Code",
        name: "セッションログ",
        run: async ({ options }) => {
            const list = await listTranscripts(options.projectDir);
            const latest = list[0];
            if (!latest) {
                return {
                    status: "warn",
                    detail: `${path.resolve(options.projectDir)} のログが ${path.join(claudeConfigDir(), "projects")} にありません`,
                    fix: "このプロジェクトで Claude Code を使ったかと、CLAUDE_CONFIG_DIR(既定は ~/.claude)の設定を確かめてください",
                };
            }
            return { status: "ok", detail: `${list.length} 件(最新: ${formatDateTime(latest.modified.toISOString())} のセッション ${latest.sessionId.slice(0, 8)})` };
        },
    },
    {
        id: "session",
        group: "Claude Code",
        name: "実行中のセッション",
        run: async ({ env }) => {
            const id = env[CURRENT_SESSION_ENV];
            return {
                status: "ok",
                detail: id
                    ? `${CURRENT_SESSION_ENV} あり(${id.slice(0, 8)}。このセッションのログを使います)`
                    : `${CURRENT_SESSION_ENV} なし(Claude Code の外での実行。プロジェクトの最新のログを使います)`,
            };
        },
    },
    {
        id: "output",
        group: "出力",
        name: "出力先",
        run: async ({ options, probes }) => {
            const dir = path.resolve(options.outDir);
            // まだない場合は、作る予定の場所のうち、既にある最も近い親で判定する(作りはしない)
            let existing = dir;
            while (!existsSync(existing) && path.dirname(existing) !== existing)
                existing = path.dirname(existing);
            try {
                await probes.writable(existing);
            }
            catch {
                return { status: "error", detail: `${dir} に書き込めません(${existing})`, fix: "書き込める場所を prepare の --out-dir で指定してください" };
            }
            return { status: "ok", detail: existing === dir ? `${dir}(書き込めます)` : `${dir}(まだありません。${existing} に作れます)` };
        },
    },
    {
        id: "settings",
        group: "設定",
        name: "環境変数",
        run: async ({ options }) => ({
            status: "ok",
            detail: (options.settings ?? [])
                .map((entry) => {
                const source = { option: "オプションで指定", env: "環境変数", default: "既定" }[entry.source];
                return entry.value === undefined ? `${entry.name}: 未設定(${entry.unset ?? source})` : `${entry.name}: ${entry.value}(${source})`;
            })
                .join("\n"),
        }),
    },
];
/** prepare の「環境」で確かめるもの(描画に必要なもの) */
export const PREPARE_CHECKS = ["ffmpeg", "chromium", "fonts", "voicevox", "speaker"];
/** 確認を順に実行する。ids を渡すとその確認だけを行う */
export async function runChecks(options, ids) {
    const probes = { ...defaultProbes, ...options.probes };
    let engine;
    const context = {
        options,
        env: options.env ?? process.env,
        probes,
        engine: () => {
            engine ??= (async () => {
                const client = new VoicevoxClient(options.voicevoxUrl, probes.fetch);
                try {
                    return await withVoicevoxStart(async () => ({ version: await client.version(), speakers: await client.speakers() }), {
                        command: options.startCommand,
                        baseUrl: options.voicevoxUrl,
                        onStart: options.onStart,
                        fetch: probes.fetch,
                    });
                }
                catch (error) {
                    return { error: error };
                }
            })();
            return engine;
        },
    };
    const results = [];
    for (const check of CHECKS) {
        if (ids && !ids.includes(check.id))
            continue;
        if (check.enabled && !check.enabled(options))
            continue;
        results.push({ id: check.id, group: check.group, name: check.name, ...(await check.run(context)) });
    }
    return results;
}
/** エラーがあれば 1 */
export function exitCodeOf(results) {
    return results.some((result) => result.status === "error") ? 1 : 0;
}
/** --json の出力。項目ごとに { id, group, status, detail, fix } */
export function toJson(results) {
    return `${JSON.stringify(results.map(({ id, group, status, detail, fix }) => ({ id, group, status, detail, fix: fix ?? null })), null, 2)}\n`;
}
const LABEL = { ok: "", warn: "[注意] ", error: "[エラー] " };
/** 人が読む形の出力 */
export function formatReport(results, options) {
    const lines = ["# 動画の作成に必要な環境の診断", ""];
    for (const group of GROUPS) {
        const items = results.filter((result) => result.group === group);
        if (items.length === 0 && !(group === "読み上げ" && !options.voice))
            continue;
        lines.push(`## ${group}`);
        if (group === "読み上げ" && !options.voice)
            lines.push("- 確認を省きました(--no-voice)");
        for (const item of items) {
            const details = item.detail.split("\n");
            // 複数行の内容(設定の一覧など)は、項目の下に箇条書きで並べる
            lines.push(`- ${item.name}: ${LABEL[item.status]}${details.length === 1 ? details[0] : ""}`.trimEnd());
            if (details.length > 1)
                lines.push(...details.map((line) => `  - ${line}`));
            if (item.fix)
                lines.push(`  - 対処: ${item.fix}`);
        }
        lines.push("");
    }
    const errors = results.filter((result) => result.status === "error").length;
    const warnings = results.filter((result) => result.status === "warn").length;
    lines.push(errors > 0
        ? `**エラー ${errors} 件、注意 ${warnings} 件。** エラーがあると動画を作れません。対処を行ってから、もう一度 dopagakix doctor で確かめてください。`
        : `エラーはありません(注意 ${warnings} 件)。`, "");
    return lines.join("\n");
}
