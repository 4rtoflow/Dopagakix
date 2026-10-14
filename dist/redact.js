/**
 * よくある形式の秘匿情報(API キー、トークン、秘密鍵など)を伏せ字にする。
 * パターンに合わない秘密は残るため、完全なマスクではない。
 */
const PATTERNS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY]"],
    [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED:ANTHROPIC_KEY]"],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:API_KEY]"],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED:GITHUB_TOKEN]"],
    [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[REDACTED:GITHUB_TOKEN]"],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:AWS_KEY]"],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED:SLACK_TOKEN]"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED:GOOGLE_KEY]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:JWT]"],
    [/(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[REDACTED]"],
    // URL に埋め込まれた認証情報 (https://user:pass@host)
    [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}@/gi, "$1[REDACTED]@"],
    // KEY=value 形式(環境変数・設定ファイル)
    [
        /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi,
        "$1[REDACTED]",
    ],
];
export function redactSecrets(input) {
    let count = 0;
    let text = input;
    for (const [pattern, replacement] of PATTERNS) {
        text = text.replace(pattern, (...args) => {
            count++;
            // 置換文字列中の $1 を手で展開する(replace の関数形式では展開されない)
            return replacement.replace("$1", typeof args[1] === "string" ? args[1] : "");
        });
    }
    return { text, count };
}
