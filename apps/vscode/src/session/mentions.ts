// Files and folders the user names in a message with `@path` or
// `@path#L10-20` (ADR 0015). They reach the agents as paths, which their
// sub-agents read, so the leader's context does not fill with files; a small
// range of lines is included as it is. Only paths inside the folder that exist
// are taken; anything else stays plain text. Node only, no `vscode`.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { ThreadUpdate } from '../webview/protocol.js';
import { looksLikeFile, refTokens } from '../webview/refs.js';

/** A range of lines this short is included in the message; a longer one is named only. */
export const MAX_EXCERPT_LINES = 80;
const MAX_EXCERPT_CHARS = 8_000;
/** At most this many mentions are taken from one message. */
const MAX_MENTIONS = 20;

const MENTION = /(^|\s)@([^\s@`'"<>|]+?)(?:#L(\d+)(?:-L?(\d+))?)?(?=$|[\s,;:!?)\]])/g;

export interface Mention {
  /** Relative to the folder, forward slashes; a folder ends with `/`. */
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly lines?: { readonly from: number; readonly to: number };
}

export interface Expanded {
  readonly mentions: readonly Mention[];
  /** What follows the user's text for the agents; empty without mentions. */
  readonly attachments: string;
}

/** The path inside the folder, or undefined when it is outside it or does not exist. */
export function inside(cwd: string, path: string): { full: string; folder: boolean } | undefined {
  if (isAbsolute(path)) return undefined;
  try {
    const root = realpathSync.native(cwd);
    const full = realpathSync.native(resolve(root, path));
    const rel = relative(root, full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return { full, folder: statSync(full).isDirectory() };
  } catch {
    return undefined;
  }
}

/** The mentions of a message and the attachments block that names them. */
export function expandMentions(text: string, cwd: string): Expanded {
  const mentions: Mention[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (mentions.length >= MAX_MENTIONS) break;
    const raw = (match[2] ?? '').replace(/\/+$/, '');
    const found = inside(cwd, raw);
    if (!found) continue;
    const path = raw.replace(/\\/g, '/') + (found.folder ? '/' : '');
    const from = match[3] ? Number(match[3]) : undefined;
    const to = match[4] ? Number(match[4]) : from;
    const key = `${path}#${String(from)}-${String(to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (found.folder || from === undefined || to === undefined) {
      mentions.push({ path, kind: found.folder ? 'folder' : 'file' });
      blocks.push(`- ${path}${found.folder ? ' (cartella)' : ''}`);
      continue;
    }
    const lines = { from: Math.min(from, to), to: Math.max(from, to) };
    mentions.push({ path, kind: 'file', lines });
    const range = `${path}, righe ${String(lines.from)}-${String(lines.to)}`;
    let excerpt: string | undefined;
    if (lines.to - lines.from + 1 <= MAX_EXCERPT_LINES) {
      try {
        const all = readFileSync(found.full, 'utf8').split(/\r?\n/);
        const part = all.slice(lines.from - 1, lines.to).join('\n');
        if (part.length <= MAX_EXCERPT_CHARS) excerpt = part;
      } catch {
        excerpt = undefined;
      }
    }
    const language = extname(path).slice(1);
    blocks.push(
      excerpt === undefined
        ? `- ${range} (troppe per includerle: leggile dal file)`
        : [`- ${range}:`, `\`\`\`${language}`, excerpt, '```'].join('\n'),
    );
  }
  return {
    mentions,
    attachments:
      blocks.length === 0
        ? ''
        : [
            'Allegati indicati dall’utente (percorsi relativi alla cartella di lavoro; leggi i',
            'file che ti servono, anche con i tuoi sotto-agenti):',
            ...blocks,
          ].join('\n'),
  };
}

/**
 * The `@` tokens of an agent's or the user's text that name a path in the
 * folder (ADR 0018), as written: the thread links them. `missing`: those that
 * look like a file and do not exist, which a delegation card points out.
 */
export function resolveRefs(text: string, cwd: string): { found: string[]; missing: string[] } {
  const found = new Set<string>();
  const missing = new Set<string>();
  for (const token of refTokens(text)) {
    const path = token.path.replace(/\/+$/, '');
    if (inside(cwd, path)) found.add(token.path);
    else if (looksLikeFile(path) && !isAbsolute(path) && !path.startsWith('..'))
      missing.add(token.path);
  }
  return { found: [...found], missing: [...missing] };
}

/**
 * A message between agents with its `@` paths as plain paths (ADR 0018), so
 * every CLI reads them the same way: `@a.ts` → `a.ts`, `@a.ts#L3-9` →
 * `a.ts (righe 3-9)`. Tokens that name nothing in the folder stay as written.
 */
export function plainRefs(text: string, cwd: string): string {
  let out = '';
  let at = 0;
  for (const token of refTokens(text)) {
    if (!inside(cwd, token.path.replace(/\/+$/, ''))) continue;
    const range = token.lines
      ? token.lines.from === token.lines.to
        ? ` (riga ${String(token.lines.from)})`
        : ` (righe ${String(token.lines.from)}-${String(token.lines.to)})`
      : '';
    out += text.slice(at, token.start) + token.path + range;
    at = token.end;
  }
  return out + text.slice(at);
}

/**
 * A thread update with the paths its text names (ADR 0018), for the thread's
 * links: a user message, a turn once done, a delegation (with the paths that
 * look like files and do not exist). Others pass unchanged.
 */
export function withRefs(update: ThreadUpdate, cwd: string): ThreadUpdate {
  const text =
    update.type === 'user' || update.type === 'approval'
      ? update.text
      : update.type === 'turn' && update.status !== 'running'
        ? (update.text ?? '')
        : '';
  if (text === '' || !text.includes('@')) return update;
  const { found, missing } = resolveRefs(text, cwd);
  return {
    ...update,
    ...(found.length > 0 ? { refs: found } : {}),
    ...(update.type === 'approval' && missing.length > 0 ? { missing } : {}),
  };
}
