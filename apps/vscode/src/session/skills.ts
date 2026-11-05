// The skills each CLI offers for the open folder (ADR 0019), for the composer's
// `$`: read from the CLIs themselves (adapters: listCodexSkills,
// listClaudeSkills), with no model turn and no quota, the first time they are
// asked for and again on request. Node only, no `vscode`: the sources are
// passed in.

import type { SkillInfo } from '@only-one-chat/adapters';
import type { Cli } from '../webview/protocol.js';

export type SkillSource = (cwd: string) => Promise<readonly SkillInfo[]>;

export type SkillList =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly skills: readonly SkillInfo[] }
  | { readonly status: 'unavailable'; readonly note: string };

export class SkillCatalog {
  private readonly lists = new Map<string, SkillList>();
  private readonly reading = new Map<string, Promise<SkillList>>();

  constructor(private readonly sources: Readonly<Record<Cli, SkillSource>>) {}

  /** The skills of a CLI for a folder: read once, unless `again`. */
  load(cli: Cli, cwd: string, again = false): Promise<SkillList> {
    const key = `${cli}\n${cwd}`;
    const known = this.lists.get(key);
    if (known && known.status !== 'loading' && !again) return Promise.resolve(known);
    const running = this.reading.get(key);
    if (running) return running;
    this.lists.set(key, { status: 'loading' });
    const read = this.sources[cli](cwd).then(
      (skills): SkillList => ({ status: 'ready', skills: [...skills] }),
      (error: unknown): SkillList => ({
        status: 'unavailable',
        note: error instanceof Error ? error.message : String(error),
      }),
    );
    this.reading.set(key, read);
    return read.then((list) => {
      this.reading.delete(key);
      this.lists.set(key, list);
      return list;
    });
  }

  /** A skill by name, once its CLI's list for the folder is read. */
  find(cli: Cli, cwd: string, name: string): SkillInfo | undefined {
    const list = this.lists.get(`${cli}\n${cwd}`);
    return list?.status === 'ready' ? list.skills.find((s) => s.name === name) : undefined;
  }
}
