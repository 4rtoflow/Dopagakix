import { readFile } from "node:fs/promises";
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function str(value) {
    return typeof value === "string" ? value : undefined;
}
/** これで始まるユーザー発言は、人間ではなく Claude Code が差し込んだもの。 */
const SYSTEM_PREFIXES = [
    "<task-notification>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<bash-stdout>",
    "<bash-stderr>",
];
const INTERRUPT_PATTERN = /^\[Request interrupted by user/;
/**
 * ユーザー発言からシステム由来の部分を取り除く。
 * スラッシュコマンドは `/name args`、`!` 実行は `! command` の形に直す。
 * 人間の発言でないと判断した場合は空文字を返す。
 */
export function cleanUserText(raw) {
    const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
    if (command) {
        const name = command[1].trim();
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
        return [name.startsWith("/") ? name : `/${name}`, args].filter(Boolean).join(" ");
    }
    const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
    if (bash)
        return `! ${bash[1].trim()}`;
    if (SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix)))
        return "";
    return text;
}
function flattenContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((block) => {
        if (!isRecord(block))
            return "";
        if (block.type === "text")
            return str(block.text) ?? "";
        if (block.type === "image")
            return "[画像]";
        if (block.type === "tool_reference")
            return `[tool:${str(block.tool_name) ?? ""}]`;
        return "";
    })
        .filter(Boolean)
        .join("\n");
}
/** AskUserQuestion の結果(toolUseResult)から、質問と人間の回答を取り出す。 */
function extractAnswers(detail) {
    if (!isRecord(detail) || !isRecord(detail.answers))
        return [];
    const annotations = isRecord(detail.annotations) ? detail.annotations : {};
    return Object.entries(detail.answers).map(([question, answer]) => {
        const note = isRecord(annotations[question]) ? str(annotations[question].notes) : undefined;
        const text = typeof answer === "string" ? answer : JSON.stringify(answer);
        return { question, answer: note ? `${text}(メモ: ${note})` : text };
    });
}
/**
 * Claude Code のセッションログ(1 行 1 JSON)を解析する。
 * ログ形式は公開仕様ではないため、未知の行や欠けた項目は読み飛ばす。
 */
export function parseTranscript(jsonl, file = "<memory>") {
    const session = { file, models: [], events: [], skippedLines: 0 };
    const models = new Set();
    const toolNames = new Map();
    const seenToolUse = new Set();
    const seenText = new Set();
    let summaryTitle;
    let lastPrompt;
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    const push = (event) => session.events.push(event);
    const addPrompt = (raw, time) => {
        const text = cleanUserText(raw);
        if (!text)
            return;
        if (INTERRUPT_PATTERN.test(text)) {
            push({ kind: "interrupt", time });
            return;
        }
        // 割り込みで送った発言は queued_command とユーザー発言の両方に残ることがある
        if (text === lastPrompt)
            return;
        lastPrompt = text;
        push({ kind: "user_prompt", time, text });
    };
    const trackTime = (time) => {
        if (!time)
            return;
        const ms = Date.parse(time);
        if (Number.isNaN(ms))
            return;
        startMs = Math.min(startMs, ms);
        endMs = Math.max(endMs, ms);
    };
    const handleUser = (line, time) => {
        const message = line.message;
        if (!isRecord(message))
            return;
        if (line.isCompactSummary === true) {
            push({ kind: "compact_summary", time, text: flattenContent(message.content) });
            return;
        }
        if (line.isMeta === true)
            return;
        const origin = isRecord(line.origin) ? str(line.origin.kind) : undefined;
        const human = origin === undefined || origin === "human";
        const content = message.content;
        if (typeof content === "string") {
            if (human)
                addPrompt(content, time);
            return;
        }
        if (!Array.isArray(content))
            return;
        const texts = [];
        let hasImage = false;
        let hasToolResult = false;
        for (const block of content) {
            if (!isRecord(block))
                continue;
            if (block.type === "text") {
                texts.push(str(block.text) ?? "");
            }
            else if (block.type === "image") {
                hasImage = true;
            }
            else if (block.type === "tool_result") {
                hasToolResult = true;
                const toolUseId = str(block.tool_use_id) ?? "";
                const name = toolNames.get(toolUseId);
                const detail = line.toolUseResult;
                push({
                    kind: "tool_result",
                    time,
                    toolUseId,
                    name,
                    isError: block.is_error === true,
                    text: flattenContent(block.content),
                    detail,
                });
                if (name === "AskUserQuestion") {
                    const answers = extractAnswers(detail);
                    if (answers.length > 0)
                        push({ kind: "user_answer", time, answers });
                }
            }
        }
        const joined = texts.join("\n").trim();
        if (hasToolResult) {
            // ツール結果に添えられた文は基本的にシステム由来。中断の記録だけ拾う。
            if (INTERRUPT_PATTERN.test(joined))
                push({ kind: "interrupt", time });
            return;
        }
        if (human && (joined || hasImage)) {
            addPrompt(hasImage ? `${joined}\n[画像を添付]`.trim() : joined, time);
        }
    };
    const handleAssistant = (line, time) => {
        const message = line.message;
        if (!isRecord(message) || !Array.isArray(message.content))
            return;
        const model = str(message.model);
        // <synthetic> は API エラー等を Claude Code が代筆したもので、エージェントの発言ではない
        if (model === "<synthetic>")
            return;
        if (model)
            models.add(model);
        const messageId = str(message.id) ?? str(line.uuid) ?? "";
        for (const block of message.content) {
            if (!isRecord(block))
                continue;
            if (block.type === "text") {
                const text = (str(block.text) ?? "").trim();
                if (!text)
                    continue;
                const key = `${messageId}\u0000${text}`;
                if (seenText.has(key))
                    continue;
                seenText.add(key);
                push({ kind: "assistant_text", time, text });
            }
            else if (block.type === "tool_use") {
                const id = str(block.id) ?? "";
                if (seenToolUse.has(id))
                    continue;
                seenToolUse.add(id);
                const name = str(block.name) ?? "unknown";
                toolNames.set(id, name);
                push({ kind: "tool_call", time, id, name, input: isRecord(block.input) ? block.input : {} });
            }
        }
    };
    const handleAttachment = (line, time) => {
        const attachment = line.attachment;
        if (!isRecord(attachment) || attachment.type !== "queued_command")
            return;
        const origin = isRecord(attachment.origin) ? str(attachment.origin.kind) : undefined;
        const mode = str(attachment.commandMode);
        const fromHuman = origin === "human" || (origin === undefined && (mode === undefined || mode === "prompt"));
        if (!fromHuman)
            return;
        addPrompt(flattenContent(attachment.prompt), time ?? str(attachment.timestamp));
    };
    for (const raw of jsonl.split(/\r?\n/)) {
        if (!raw.trim())
            continue;
        let line;
        try {
            line = JSON.parse(raw);
        }
        catch {
            session.skippedLines++;
            continue;
        }
        if (!isRecord(line))
            continue;
        // サブエージェント内部のやり取りは、呼び出し元の Agent ツール結果で要約されている
        if (line.isSidechain === true)
            continue;
        const time = str(line.timestamp);
        session.sessionId ??= str(line.sessionId);
        if (str(line.cwd))
            session.cwd = str(line.cwd);
        if (str(line.gitBranch))
            session.gitBranch = str(line.gitBranch);
        if (str(line.version))
            session.version = str(line.version);
        switch (line.type) {
            case "ai-title":
                session.title = str(line.aiTitle) ?? session.title;
                break;
            case "summary":
                summaryTitle ??= str(line.summary);
                break;
            case "user":
                trackTime(time);
                handleUser(line, time);
                break;
            case "assistant":
                trackTime(time);
                handleAssistant(line, time);
                break;
            case "attachment":
                handleAttachment(line, time);
                break;
            default:
                break;
        }
    }
    session.title ??= summaryTitle;
    session.models = [...models];
    if (Number.isFinite(startMs))
        session.startTime = new Date(startMs).toISOString();
    if (Number.isFinite(endMs))
        session.endTime = new Date(endMs).toISOString();
    return session;
}
export async function readTranscript(file) {
    return parseTranscript(await readFile(file, "utf8"), file);
}
