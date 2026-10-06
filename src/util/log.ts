export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * 進捗表示。端末では同じ行を書き換え、そうでなければ 25% ごとに 1 行出す。
 */
export function progress(label: string): (done: number, total: number) => void {
  const tty = process.stderr.isTTY;
  let lastQuarter = -1;
  return (done, total) => {
    const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
    if (tty) {
      process.stderr.write(`\r${label} ${done}/${total} (${percent}%)`);
      if (done >= total) process.stderr.write("\n");
      return;
    }
    const quarter = Math.floor(percent / 25);
    if (quarter !== lastQuarter) {
      lastQuarter = quarter;
      log(`${label} ${done}/${total} (${percent}%)`);
    }
  };
}
