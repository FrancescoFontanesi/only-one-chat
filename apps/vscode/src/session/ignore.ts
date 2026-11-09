// Paths the extension leaves out of what it records of the folder (ADR 0021):
// the verified facts the leader reads, the checkpoints and the changes card.
// Patterns are written as in a .gitignore, a subset of it:
// - `name` matches a file or folder with that name at any depth;
// - a pattern with a `/` inside or at the start is anchored to the folder: `graft/.cache`;
// - a trailing `/` matches folders only: `graft/`;
// - `*` matches within a name, `?` one character, `**` any number of folders;
// - blank lines and `#` comments are skipped. No `!` negation.
// Node only, no `vscode`.

/** True when a path, relative to the folder with `/` separators, is left out. */
export type Ignored = (path: string, folder: boolean) => boolean;

export const NOTHING_IGNORED: Ignored = () => false;

function toRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      // `**/` any folders (or none); a final `**` everything below.
      if (glob.charAt(i + 2) === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

export function ignoredPaths(patterns: readonly string[]): Ignored {
  const rules = patterns
    .map((raw) => raw.trim().replace(/\\/g, '/'))
    .filter((pattern) => pattern !== '' && !pattern.startsWith('#') && !pattern.startsWith('!'))
    .map((pattern) => ({
      folderOnly: pattern.endsWith('/'),
      body: pattern.replace(/\/+$/, ''),
    }))
    .filter(({ body }) => body.replace(/^\/+/, '') !== '')
    .map(({ folderOnly, body }) => {
      const source = toRegExp(body.replace(/^\/+/, ''));
      return {
        folderOnly,
        regexp: new RegExp(body.includes('/') ? `^${source}$` : `(?:^|/)${source}$`),
      };
    });
  if (rules.length === 0) return NOTHING_IGNORED;
  return (path, folder) =>
    rules.some((rule) => (folder || !rule.folderOnly) && rule.regexp.test(path));
}
