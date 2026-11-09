// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- every tsconfig that compiles the runtime must see the *.md declaration
/// <reference path="./markdown.d.ts" />
// The role prompts of the leader and the implementer (ADR 0020), kept as
// Markdown in ../prompts so they can be read and edited as they are. The
// bundlers load them as text (esbuild's text loader, the vitest plugin, the
// dev loader); `{{name}}` marks what the runtime fills in.

import implementer from '../prompts/implementer.md';
import leader from '../prompts/leader.md';

export const LEADER_PROMPT: string = leader;
export const IMPLEMENTER_PROMPT: string = implementer;

/** A prompt with its `{{name}}` placeholders filled; an unknown one is an error. */
export function fillPrompt(template: string, values: Readonly<Record<string, string>>): string {
  return template.trimEnd().replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Prompt placeholder {{${name}}} has no value`);
    return value;
  });
}
