// How risky a change is, estimated by the runtime from the change itself, with
// no model (ADR 0032). The measures are those of just-in-time defect prediction
// (Kamei et al.): the size of the change weighs most, then how it spreads over
// files and folders; then the decision points it adds, how many files depend on
// what it touches, and code changed with no test changed. Each measure is
// brought to 0..1 with a cap, so that none dominates, and they are summed with
// fixed weights. Two signals raise the level whatever the sum: code that
// touches what an attacker controls (files, commands, network, data) and the
// shortcut flags (ADR 0030). The weights and caps are choices, to be tuned on
// real changes: a level is a reason to review, not a verdict. Pure: no disk.

import { lineCounts } from './checkpoints.js';
import { TEST_FILE, shortcutFlags, type TextChange } from './shortcuts.js';

export type RiskLevel = 'basso' | 'medio' | 'alto';

export interface RiskAssessment {
  readonly level: RiskLevel;
  /** The weighted sum, 0..1, before the signals that raise the level. */
  readonly score: number;
  /** Why, in words, for the facts. */
  readonly reasons: readonly string[];
}

const CODE_FILE = /\.(py|[cm]?[jt]sx?|go|rs|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|scala|sh|ps1)$/i;

/** Decision points, as cyclomatic complexity counts them, in any of the usual languages. */
const DECISIONS =
  /\b(?:if|elif|else if|for|foreach|while|case|catch|except|when)\b|&&|\|\||\?\?|\band\b(?=\s)|\bor\b(?=\s)|\?(?=[^:\n]*:)/g;

/** What an attacker can reach, by the calls that reach it. */
const SENSITIVE: readonly (readonly [string, RegExp])[] = [
  [
    'file e percorsi',
    /\bopen\s*\(|readFile|writeFile|\bfs\.|os\.path|pathlib|\bPath\s*\(|realpath|unlink|rmSync|shutil|createReadStream/,
  ],
  [
    'comandi',
    /subprocess|child_process|\bspawn\s*\(|\bexec(?:Sync|File)?\s*\(|os\.system|popen|ShellExecute|Process\.Start/,
  ],
  [
    'rete',
    /\bfetch\s*\(|https?:\/\/|\bsocket\b|requests\.|axios|urllib|http\.(?:get|request)|WebSocket/,
  ],
  [
    'codice o dati non fidati',
    /\beval\s*\(|new Function\s*\(|pickle\.|yaml\.load\s*\((?![^)]*SafeLoader)|marshal\.|deserializ|innerHTML|dangerouslySetInnerHTML/i,
  ],
  ['query', /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(?:\+|\$\{|%s|f["'])/],
  ['credenziali', /password|secret|token|api[_-]?key|credential|private[_-]?key/i],
];

const count = (text: string | null, pattern: RegExp) => text?.match(pattern)?.length ?? 0;
const cap = (value: number, max: number) => Math.min(1, value / max);
const logCap = (value: number, max: number) =>
  Math.min(1, Math.log2(1 + value) / Math.log2(1 + max));

/** Lines that are in `after` and not in `before`, as a multiset: the added code, roughly. */
function addedText(before: string | null, after: string | null): string {
  if (after === null) return '';
  const left = new Map<string, number>();
  for (const line of (before ?? '').split('\n')) left.set(line, (left.get(line) ?? 0) + 1);
  return after
    .split('\n')
    .filter((line) => {
      const n = left.get(line) ?? 0;
      if (n === 0) return true;
      left.set(line, n - 1);
      return false;
    })
    .join('\n');
}

/** The module name other files use for a path: `src/session/chat.ts` → `chat`. */
function stem(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.[^.]+$/, '');
}

/**
 * How many other code files name one of the changed files where they import
 * or include it: the most depended upon of the changed files.
 */
export function fanIn(changed: readonly string[], files: ReadonlyMap<string, string>): number {
  let most = 0;
  for (const path of changed) {
    const name = stem(path);
    if (name.length < 2 || name === 'index') continue;
    const uses = new RegExp(
      String.raw`(?:\bimport\b|\bfrom\b|\brequire\s*\(|#include|\buse\b)[^\n]*\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`,
    );
    let users = 0;
    for (const [other, text] of files) {
      if (other !== path && CODE_FILE.test(other) && uses.test(text)) users++;
    }
    most = Math.max(most, users);
  }
  return most;
}

/**
 * The risk of a change: `changes` are the files it changed, with their text
 * before and after; `files` the folder's code files now, for who depends on
 * what changed.
 */
export function assessRisk(
  changes: readonly TextChange[],
  files: ReadonlyMap<string, string>,
): RiskAssessment {
  const code = changes.filter((c) => !TEST_FILE.test(c.path));
  const tests = changes.filter((c) => TEST_FILE.test(c.path));
  const churns = code.map((c) => {
    const { added, removed } = lineCounts(c.before ?? '', c.after ?? '');
    return added + removed;
  });
  const churn = churns.reduce((a, b) => a + b, 0);
  const folders = new Set(code.map((c) => c.path.split('/').slice(0, -1).join('/')));
  const added = code.map((c) => addedText(c.before, c.after)).join('\n');
  const decisions = Math.max(
    0,
    code.reduce((sum, c) => sum + count(c.after, DECISIONS) - count(c.before, DECISIONS), 0),
  );
  const dependents = fanIn(
    code.map((c) => c.path),
    files,
  );
  const untested = churn > 20 && tests.length === 0;

  const score =
    0.3 * logCap(churn, 400) +
    0.2 * Math.max(cap(code.length - 1, 9), cap(folders.size - 1, 4)) +
    0.2 * cap(decisions, 25) +
    0.15 * logCap(dependents, 20) +
    0.15 * (untested ? 1 : 0);
  const reasons = [
    `${String(code.length)} file di codice, ${String(churn)} righe cambiate`,
    ...(folders.size > 1 ? [`${String(folders.size)} cartelle`] : []),
    ...(decisions > 0 ? [`+${String(decisions)} punti di decisione`] : []),
    ...(dependents > 0 ? [`usato da ${String(dependents)} file`] : []),
    ...(untested ? ['nessun test cambiato'] : []),
  ];
  let level: RiskLevel = score >= 0.55 ? 'alto' : score >= 0.25 ? 'medio' : 'basso';
  const raise = (to: RiskLevel, why: string) => {
    reasons.push(why);
    if (to === 'alto' || level === 'basso') level = to;
  };
  const touched = SENSITIVE.filter(([, pattern]) => pattern.test(added)).map(([name]) => name);
  if (touched.length > 0) raise('alto', `tocca ${touched.join(', ')}`);
  const flags = shortcutFlags(changes).length;
  if (flags > 0) raise('medio', `${String(flags)} segnalazioni dei controlli sul diff`);
  return { level, score: Math.round(score * 100) / 100, reasons };
}

/** The assessment as a line of the facts. */
export function riskFact(risk: RiskAssessment): string {
  return `Rischio della modifica, stimato dal runtime: ${risk.level} (${risk.score.toFixed(2).replace('.', ',')}) — ${risk.reasons.join('; ')}.`;
}
