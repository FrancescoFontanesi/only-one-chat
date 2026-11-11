// A node of Squad's board (ADR 0023): an agent besides the leader and the
// implementer, with its own thread and session, spoken to directly. Isolated:
// it does not see the chat's thread, nor the chat its; no delegation, no
// review, no checkpoint. What it changes in the folder is shown as the files
// changed. Any provider of the table (ADR 0022). Node only, no `vscode`.

import {
  antigravityLevel,
  startPermissionBridge,
  type PermissionBridge,
  type PermissionBridgeOptions,
} from '@only-one-chat/adapters';
import { agentLabel, agentSessionOptions, type AgentSession } from '@only-one-chat/runtime';
import { NODE_NAME_LENGTH, type PermitDecision, type ThreadUpdate } from '../webview/protocol.js';
import { summarize } from './chat.js';
import { changes, snapshot } from './facts.js';
import { ignoredPaths, type Ignored } from './ignore.js';
import { PROVIDERS, type ProviderChoice, type ProviderConfig } from './providers.js';

export interface NodeChoice extends ProviderChoice {
  readonly id: string;
  readonly name: string;
}

export interface NodeConfig extends ProviderConfig {
  readonly node: NodeChoice;
  /** The provider's own session of a reopened chat, to continue. */
  readonly resume?: string;
  /** For a Claude node that may write: its permission hook (R9). */
  readonly permissionHook?: PermissionBridgeOptions;
  readonly ignoredPaths?: readonly string[];
}

export interface NodeEvents {
  update(update: ThreadUpdate): void;
  busy(busy: boolean): void;
  /** The provider's session, once known: kept with the chat to reopen it. */
  sessionId?(id: string): void;
}

const NODE_ID = /^[a-z0-9-]{1,64}$/;

/** The nodes of the settings (ADR 0023); an entry of the wrong shape is left out. */
export function nodesOf(value: unknown): NodeChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry): NodeChoice[] => {
    const n = entry as Partial<Record<keyof NodeChoice, unknown>> | null;
    if (typeof n !== 'object' || n === null) return [];
    const { id, name, cli, model, effort, permission } = n;
    if (typeof id !== 'string' || !NODE_ID.test(id) || seen.has(id)) return [];
    if (typeof name !== 'string' || name.trim() === '' || typeof model !== 'string') return [];
    if (cli !== 'codex' && cli !== 'claude' && cli !== 'antigravity') return [];
    seen.add(id);
    // A node written before the levels were reasoning keeps its level in the model id.
    const level = cli === 'antigravity' && !effort ? antigravityLevel(model) : null;
    return [
      {
        id,
        name: name.trim().slice(0, NODE_NAME_LENGTH),
        cli,
        model: level?.model ?? model,
        effort: level?.effort ?? (typeof effort === 'string' ? effort : ''),
        // Read-only unless the settings say otherwise (ADR 0023).
        permission: permission === 'ask' || permission === 'auto' ? permission : 'read-only',
      },
    ];
  });
}

/** What a node is told before the user's first message. */
export function nodeInstructions(node: NodeChoice): string {
  const lines = [
    `Sei "${node.name}", un agente di Only One Chat. L’utente ti scrive direttamente, in una`,
    'conversazione tua: non vedi le altre conversazioni della chat, né il leader né',
    'l’implementatore. Rispondi in italiano.',
  ];
  if (node.permission === 'read-only') {
    lines.push(
      'Sei in sola lettura: leggi i file con i tuoi strumenti di lettura e di ricerca. I comandi di',
      'terminale e le modifiche ai file ti sono negati dal ruolo, non usarli.',
    );
  } else {
    lines.push('Lavori nella cartella aperta e non modifichi nulla fuori da essa.');
  }
  return lines.join('\n');
}

export class NodeSession {
  private session: AgentSession | undefined;
  private bridge: PermissionBridge | undefined;
  private running = false;
  private stopTurn: (() => Promise<void>) | undefined;
  private turnId: string | undefined;
  private resume: string | undefined;
  private nextId = 1;
  private readonly tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private readonly permissions = new Map<string, (decision: PermitDecision) => void>();
  private readonly ignored: Ignored;

  constructor(
    private config: NodeConfig,
    private readonly events: NodeEvents,
  ) {
    this.resume = config.resume;
    this.ignored = ignoredPaths(config.ignoredPaths ?? []);
  }

  get busy(): boolean {
    return this.running;
  }

  get node(): NodeChoice {
    return this.config.node;
  }

  /**
   * The node as the settings now say. A new provider or permission opens a
   * new session with the next message; a new model goes to the same session.
   */
  async configure(node: NodeChoice): Promise<void> {
    const before = this.config.node;
    this.config = { ...this.config, node };
    if (node.cli !== before.cli || node.permission !== before.permission) {
      await this.close();
      return;
    }
    const provider = PROVIDERS[node.cli];
    const id = (choice: NodeChoice) => provider.modelId?.(choice) ?? choice.model;
    if (id(node) !== id(before)) this.session?.setModel?.(id(node));
    if (!provider.modelId && node.effort !== before.effort) this.session?.setEffort?.(node.effort);
  }

  private id(prefix: string): string {
    return `${prefix}-${this.tag}-${String(this.nextId++)}`;
  }

  private async open(): Promise<AgentSession> {
    const { node } = this.config;
    const provider = PROVIDERS[node.cli];
    const agent = `${provider.name} (${node.model})`;
    if (provider.bridged && this.config.permissionHook && node.permission !== 'read-only') {
      this.bridge ??= await startPermissionBridge(
        (request) => this.askPermission(agent, request.summary),
        this.config.permissionHook,
      );
    }
    const resume = this.resume;
    this.resume = undefined;
    return provider.factory(
      this.config,
      { choice: node, leader: false },
      this.bridge,
    )({
      ...agentSessionOptions(nodeInstructions(node), undefined),
      ...(resume ? { resume } : {}),
    });
  }

  /** The user's message to the node: one turn, shown in the node's thread. */
  async send(text: string, attached?: { readonly text: string }): Promise<void> {
    if (this.running) {
      this.events.update({
        type: 'notice',
        level: 'warn',
        text: 'Un messaggio è già in corso: aspetta o fermalo.',
      });
      return;
    }
    this.running = true;
    this.events.busy(true);
    this.events.update({ type: 'user', id: this.id('u'), text, to: 'implementer' });
    const prompt = attached?.text ? `${text}\n\n${attached.text}` : text;
    const { cwd } = this.config;
    const baseline = snapshot(cwd, this.ignored);
    try {
      this.session ??= await this.open();
      const session = this.session;
      const id = this.id('t');
      this.turnId = id;
      // A node's turns are drawn as a worker's; the thread names the node.
      this.events.update({
        type: 'turn',
        id,
        role: 'implementer',
        agent: session.name,
        status: 'running',
      });
      const turn = session.runTurn(prompt, {
        onText: (chunk) => {
          this.events.update({ type: 'chunk', turnId: id, text: chunk });
        },
        onApprovalRequest: (request) => this.askPermission(session.name, request.summary),
        onStep: (step) => {
          this.events.update({ type: 'step', turnId: id, step });
        },
      });
      this.stopTurn = () => turn.stop();
      const result = await turn.done;
      this.turnId = undefined;
      const usage = summarize(result.usage);
      this.events.update({
        type: 'turn',
        id,
        role: 'implementer',
        agent: session.name,
        status: 'done',
        label: agentLabel(result.identity),
        text: result.text,
        ...(usage ? { usage } : {}),
      });
      if (result.identity.sessionId) this.events.sessionId?.(result.identity.sessionId);
    } catch (error) {
      this.events.update({
        type: 'notice',
        level: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.turnId) {
        this.events.update({
          type: 'turn',
          id: this.turnId,
          role: 'implementer',
          agent: '',
          status: 'failed',
        });
        this.turnId = undefined;
      }
      this.running = false;
      this.stopTurn = undefined;
      const changed = changes(baseline, snapshot(cwd, this.ignored));
      if (changed !== 'unknown' && changed.length > 0) {
        this.events.update({
          type: 'notice',
          level: 'info',
          text: ['File cambiati:', ...changed.map((c) => `- ${c}`)].join('\n'),
        });
      }
      this.events.busy(false);
    }
  }

  private askPermission(agent: string, summary: string): Promise<PermitDecision> {
    return new Promise((resolve) => {
      const id = this.id('p');
      this.permissions.set(id, resolve);
      this.events.update({ type: 'permission', id, role: 'implementer', agent, summary });
    });
  }

  /** The user's answer to a permission request of this node; another id is not its. */
  permit(id: string, decision: PermitDecision): boolean {
    const resolve = this.permissions.get(id);
    if (!resolve) return false;
    this.permissions.delete(id);
    resolve(decision);
    this.events.update({ type: 'permission_closed', id, decision });
    return true;
  }

  async stop(): Promise<void> {
    for (const id of [...this.permissions.keys()]) this.permit(id, 'decline');
    await this.stopTurn?.();
  }

  /** Ends the node's session; the next message opens a new one. */
  async close(): Promise<void> {
    await this.stop();
    await this.session?.close();
    this.session = undefined;
    await this.bridge?.close();
    this.bridge = undefined;
  }
}
