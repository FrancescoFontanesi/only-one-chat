// Orchestration runtime: one conversation, a leader, workers, delegation,
// persistent tasks and failover (see docs/architecture.md).
//
// TODO(orchestrator): nothing of the orchestrator is implemented yet. This
// package must stay free of any `vscode` import so it can be tested in plain
// Node and reused outside the extension host.

import pkg from '../package.json' with { type: 'json' };

export interface RuntimeInfo {
  readonly name: string;
  readonly version: string;
}

export function getRuntimeInfo(): RuntimeInfo {
  return { name: pkg.name, version: pkg.version };
}
