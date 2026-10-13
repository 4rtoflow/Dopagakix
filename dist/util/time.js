function parts(iso, timeZone) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return undefined;
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });
    return Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
}
/** "HH:MM"。解釈できない時刻は空文字。 */
export function formatClock(iso, timeZone) {
    const p = iso ? parts(iso, timeZone) : undefined;
    return p ? `${p.hour}:${p.minute}` : "";
}
/** "YYYY/MM/DD HH:MM" */
export function formatDateTime(iso, timeZone) {
    const p = iso ? parts(iso, timeZone) : undefined;
    return p ? `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}` : "";
}
/** ファイル名用の "YYYYMMDD-HHMMSS" */
export function formatStamp(date, timeZone) {
    const p = parts(date.toISOString(), timeZone);
    return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
/** タイムゾーン名(表示用)。未指定なら実行環境のもの。 */
export function zoneLabel(timeZone) {
    return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
