// Tests must not inherit the developer's keys, proxies or agent sessions (ADR 0041).
const DROP = /^(ANTHROPIC_|CLAUDE|OPENAI_|GEMINI_|GOOGLE_|AGY_|(HTTP|HTTPS|ALL|NO)_PROXY$)/i;

/** True for a variable the tests never see; CODEX_EXECUTABLE opts into the live tests. */
export function dropped(name: string): boolean {
  return DROP.test(name) || (/^CODEX_/i.test(name) && name.toUpperCase() !== 'CODEX_EXECUTABLE');
}

for (const name of Object.keys(process.env)) {
  if (dropped(name)) Reflect.deleteProperty(process.env, name);
}
