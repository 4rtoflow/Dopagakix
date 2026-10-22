import { narrationBudget, SENTENCE_LIMIT } from "./script/check.js";
import { formatDateTime } from "./util/time.js";
function formatMinutes(minutes) {
    if (minutes === undefined)
        return "不明";
    return minutes < 60 ? `${minutes} 分` : `約 ${(minutes / 60).toFixed(1)} 時間`;
}
const number = (n) => n.toLocaleString("ja-JP");
const STATUS_LABEL = { ok: "", warn: "[注意] ", error: "[不足] " };
/** prepare の出力。エージェントが台本を書くときに参照する情報をまとめる。 */
export function buildBrief(input) {
    const { facts, persona } = input;
    const added = facts.files.reduce((n, f) => n + f.added, 0);
    const removed = facts.files.reduce((n, f) => n + f.removed, 0);
    const start = formatDateTime(facts.startTime, input.timeZone);
    const end = formatDateTime(facts.endTime, input.timeZone);
    const topFiles = [...facts.files].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 8);
    const missing = input.environment.filter((item) => item.status === "error");
    const voice = persona
        ? [
            `## 読み上げ文の口調: ${persona.name}`,
            `- ${persona.style}`,
            persona.examples.length > 0 ? `- 例: ${persona.examples.map((e) => `「${e}」`).join("")}` : undefined,
            "- 口調を付けるのは narration だけ。画面の文字(title・headline・summary・items など)は中立に書く。",
            "- 口調に合わせて事実を変えたり、誇張したりしない。",
            persona.endingPattern ? "- 文末は check と render で確かめられる。" : undefined,
        ]
        : ["## 読み上げ文の口調: 丁寧語", "- 指示者に直接報告する丁寧語(です・ます)で書く。"];
    const lines = [
        "# 動画レポートの準備",
        "",
        missing.length > 0
            ? `**描画に必要なものが不足しています(${missing.map((m) => m.name).join("、")})。\`dopagakix doctor\` を実行し、エラーの項目と対処を指示者に伝えてください。**\n`
            : undefined,
        "## 手順",
        `1. 台本を書く: ${input.reportFile}`,
        `2. 確かめる: ${input.checkCommand}`,
        `3. 描画する: ${input.renderCommand}`,
        `- 細部を思い出せないときは、ログを振り返る: ${input.digestCommand}`,
        "",
        "## 画面に出る数値(セッションログから自動集計。台本の内容と矛盾させないこと)",
        `- 対象: セッション全体(${facts.sessionId?.slice(0, 8) ?? "ID 不明"}${facts.title ? `「${facts.title}」` : ""})`,
        `- 期間: ${start ? `${start} – ${end}` : "不明"}(作業時間 ${formatMinutes(facts.activeMinutes)}、開始からの経過 ${formatMinutes(facts.elapsedMinutes)})`,
        `- 指示 ${number(facts.userPrompts)} 回 ・ ツール実行 ${number(facts.toolCalls)} 回(コマンド ${number(facts.commandsRun)} 回、うちエラー終了 ${number(facts.commandsFailed)} 回)`,
        `- 変更ファイル ${number(facts.files.length)} 件(+${number(added)} −${number(removed)})`,
        ...topFiles.map((f) => `  - ${f.path}(+${number(f.added)} −${number(f.removed)}${f.created ? "、新規" : ""})`),
        facts.files.length > topFiles.length ? `  - ほか ${facts.files.length - topFiles.length} 件` : undefined,
        "- 変更ファイルと行数は、Edit / Write ツールでの変更だけを数えたもの(シェルのコマンドで変更・削除したファイルは含まない)",
        "",
        ...voice,
        "",
        "## 長さ",
        `- narration は全シーン合計で全角 ${narrationBudget(input.seconds)} 文字程度(約 ${input.seconds} 秒)。1 文は ${SENTENCE_LIMIT} 文字以内、各シーン 1〜3 文。`,
        "",
        "## 環境",
        input.voice ? undefined : "- 読み上げ: なし(字幕のみで作成。動画の柱に「音声なし」と表示)",
        ...input.environment.map((item) => `- ${item.name}: ${STATUS_LABEL[item.status]}${item.detail.replaceAll("\n", " / ")}`),
        "",
    ];
    return lines.filter((line) => line !== undefined).join("\n");
}
