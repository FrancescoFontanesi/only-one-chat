// Lines added and removed between two texts, for the diff checks and the checkpoints'
// review. Pure: no `vscode`, no disk.

/** A diff longer than this many edits is not computed line by line. */
const MAX_EDITS = 20_000;

/** Lines added and removed between two texts (Myers' shortest edit script, lengths only). */
export function lineCounts(before: string, after: string): { added: number; removed: number } {
  // A final newline ends the last line; it does not start another.
  const lines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/));
  const a = lines(before);
  const b = lines(after);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const v = new Map<number, number>([[1, 0]]);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) return { added: (d + m - n) / 2, removed: (d - m + n) / 2 };
    }
  }
  return { added: m, removed: n };
}
