// Hermetic environment for tests that launch processes: only what Node, the
// fakes and the Windows process tools (taskkill, powershell) need to run, plus
// what the test sets itself. The machine's provider, proxy and CLI variables
// (ANTHROPIC_BASE_URL, CODEX_HOME, HTTPS_PROXY, CLAUDE_CODE_*, …) never leak
// in, since they change what the code under test decides.

const KEEP = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
].map((name) => name.toLowerCase());

export function testEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && KEEP.includes(name.toLowerCase())) env[name] = value;
  }
  return { ...env, ...extra };
}
