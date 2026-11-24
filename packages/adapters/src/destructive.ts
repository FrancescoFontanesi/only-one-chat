// Commands that destroy data, rewrite history or publish (ADR 0050): a request
// that runs one is never approved "for the session", on any provider, only
// once. A closed list, matched on the command's text: a heuristic for what the
// user is asked, not a sandbox. Pure, no `vscode`.

/** Before a command word: the start, a shell separator, or a wrapper that runs it, quoted or not. */
const AT_COMMAND = String.raw`(?:^|[;&|(\n\r\`{]|\$\(|(?:^|\s)(?:sudo|xargs|-Command|-c|/c)\s+['"]?)\s*`;
/** After a command word: its end, so `format_price()` or `rmdir2` is not one. */
const END = String.raw`(?=$|[\s;&|)'"\`])`;

const PROGRAMS = [
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'Remove-Item',
  'ri',
  'Clear-Content',
  'shred',
  'unlink',
  'format',
  'chmod',
  'chown',
  'icacls',
  'takeown',
  'dd',
  'mkfs(?:\\.\\w+)?',
  'diskpart',
  'Stop-Process',
  'kill',
  'killall',
  'pkill',
  'taskkill',
];

const PATTERNS: readonly RegExp[] = [
  new RegExp(`${AT_COMMAND}(?:${PROGRAMS.join('|')})${END}`, 'i'),
  /\breg(?:\.exe)?\s+delete\b/i,
  /\bgit\s+push\b[^;&|\n]*\s(?:-f|--force|--force-with-lease)(?=$|[\s=;&|'"])/i,
  /\bgit\s+reset\b[^;&|\n]*\s--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\b[^;&|\n]*\s--(?=$|\s)/i,
  /\bgit\s+restore\b/i,
  // Case matters: `-d` only deletes a merged branch.
  /\bgit\s+branch\b[^;&|\n]*\s-D(?=$|\s)/,
  /\bgit\s+rebase\b/i,
  /\bgit\s+filter-(?:branch|repo)\b/i,
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
  /\b(?:npm|pnpm)\s+publish\b/i,
];

/** Whether a command line runs something of the closed list above. */
export function isDestructiveCommand(command: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Whether a tool call is destructive: its `command` when the input has one
 * (a shell tool), else the text shown to the user.
 */
export function isDestructiveRequest(tool: string, input: unknown, summary: string): boolean {
  const command =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)['command']
      : undefined;
  // The summary starts with the tool's name (`Bash: …`): the command follows it.
  const shown = summary.startsWith(`${tool}: `) ? summary.slice(tool.length + 2) : summary;
  return isDestructiveCommand(typeof command === 'string' ? command : shown);
}
