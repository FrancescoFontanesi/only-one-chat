// The handoff tools (ADR 0035) in the three adapters, against the fake CLIs: the
// server `ooc` is registered with its tools, its calls run without asking
// anyone, and the main agent's calls come back as `handoffs`. The directives
// that make a fake call a tool are documented at the top of each fake.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeTurnArgs,
  createAcpAgentFactory,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  handoffThreadConfig,
  isHandoffApproval,
  type AgentApprovalRequest,
  type AgentSession,
  type AgentTurnHandlers,
  type HandoffTools,
} from '../src/index.js';
import { testEnv } from './env.js';

const FAKE_CODEX = join(import.meta.dirname, 'fixtures', 'fake-app-server.mjs');
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_AGY = join(import.meta.dirname, 'fixtures', 'fake-agy.mjs');

const handoff: HandoffTools = {
  server: { command: 'node', args: ['C:/ext/handoff-main.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
  tools: [
    { name: 'report', description: 'Report.', inputSchema: { type: 'object' } },
    { name: 'review', description: 'Review.', inputSchema: { type: 'object' } },
  ],
};
const OOC_ENV = { ELECTRON_RUN_AS_NODE: '1', OOC_HANDOFF_TOOLS: JSON.stringify(handoff.tools) };

const report = { outcome: 'done', text: 'Fatto.' };
const review = { verdict: 'approved', note: 'ok', toolSummary: 'extra field, kept as reported' };
const calls = [
  `[handoff report ${JSON.stringify(report)}]`,
  `[handoff-sub report ${JSON.stringify({ outcome: 'blocked' })}]`,
  `[handoff review ${JSON.stringify(review)}]`,
].join('\n');

let dir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handoff '));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function handlers() {
  const approvals: AgentApprovalRequest[] = [];
  const value: AgentTurnHandlers = {
    onText: () => undefined,
    onApprovalRequest: (request) => {
      approvals.push(request);
      return Promise.resolve('decline');
    },
  };
  return { value, approvals };
}

const jsonLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];

describe('Claude Code', () => {
  const log = () => join(dir, 'claude.jsonl');
  const base = { executable: 'claude', cwd: dir, prompt: 'x' };
  const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  function open(
    fakeFlags: string[] = [],
    extra: Partial<Parameters<typeof createClaudeAgentFactory>[0]> = {},
    withHandoff: HandoffTools | null = handoff,
  ) {
    return createClaudeAgentFactory({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE, `--log=${log()}`, ...fakeFlags],
      cwd: dir,
      baseEnv: testEnv(),
      shutdownTimeoutMs: 300,
      ...extra,
    })({ instructions: 'Sei il worker.', ...(withHandoff ? { handoff: withHandoff } : {}) });
  }

  it('registers only ooc with its tools, inline, and allows them even read-only', () => {
    const args = claudeTurnArgs({ ...base, handoff });
    expect(JSON.parse(argValue(args, '--mcp-config') ?? '')).toEqual({
      mcpServers: {
        ooc: { type: 'stdio', command: 'node', args: ['C:/ext/handoff-main.js'], env: OOC_ENV },
      },
    });
    expect(args).toContain('--strict-mcp-config');
    expect(argValue(args, '--tools')).toBe('Read,Grep,Glob');
    expect(argValue(args, '--allowedTools')).toBe('mcp__ooc__report,mcp__ooc__review');
    expect(argValue(args, '--permission-prompts')).toBe('none');
  });

  it('merges the tools into the sandbox rules, and keeps them when every edit asks', () => {
    const sandbox = { commands: ['python'] };
    expect(argValue(claudeTurnArgs({ ...base, handoff, sandbox }), '--allowedTools')).toBe(
      'Edit(./**),Bash(python *),mcp__ooc__report,mcp__ooc__review',
    );
    const askAll = { settings: '{}', env: {}, askAll: true };
    expect(
      argValue(
        claudeTurnArgs({ ...base, handoff, sandbox, permissionHook: askAll }),
        '--allowedTools',
      ),
    ).toBe('mcp__ooc__report,mcp__ooc__review');
  });

  it('changes nothing without handoff tools', () => {
    const args = claudeTurnArgs(base);
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(args).toContain('--strict-mcp-config');
  });

  it('surfaces the main agent’s calls to ooc in order, with their input, and not a sub-agent’s', async () => {
    const session = await open();
    sessions.push(session);
    const result = await session.runTurn(`lavora\n${calls}`, handlers().value).done;
    expect(result.handoffs).toEqual([
      { tool: 'report', arguments: report },
      { tool: 'review', arguments: review },
    ]);
    expect(result.text).toContain('handoffs: report=allowed, report=allowed, review=allowed');
    const turn = jsonLines<{ argv?: string[] }>(log()).find((e) => e.argv?.includes('-p'));
    expect(JSON.parse(argValue(turn?.argv ?? [], '--mcp-config') ?? '')).toMatchObject({
      mcpServers: { ooc: { env: OOC_ENV } },
    });
  });

  it('reports no handoffs when there are none, and without the option', async () => {
    const session = await open([], {}, null);
    sessions.push(session);
    const result = await session.runTurn(`x\n[handoff report {}]`, handlers().value).done;
    expect(result.handoffs).toBeUndefined();
    // Not allowed in advance: the fake denies it, as --permission-prompts none would.
    expect(result.text).toContain('report=denied');
  });

  it('does not allow, nor report, a tool of another MCP server', async () => {
    const session = await open();
    sessions.push(session);
    const result = await session.runTurn(
      `x\n[handoff@docs search {"q":1}]\n[handoff report {}]`,
      handlers().value,
    ).done;
    expect(result.text).toContain('handoffs: search=denied, report=allowed');
    expect(result.handoffs).toEqual([{ tool: 'report', arguments: {} }]);
  });

  it('answers allow to an ooc permission request on stdio, and denies another tool', async () => {
    const session = await open(['--ask-handoff'], {
      questions: { denyMessage: 'Negato dal ruolo.' },
    });
    sessions.push(session);
    const result = await session.runTurn(
      `x\n[handoff report {"a":1}]\n[handoff@docs search {}]`,
      handlers().value,
    ).done;
    expect(result.text).toContain('handoffs: report=allowed, search=denied');
    expect(result.handoffs).toEqual([{ tool: 'report', arguments: { a: 1 } }]);
  });
});

describe('Codex', () => {
  const received = () => join(dir, 'received.jsonl');

  function open(withHandoff: HandoffTools | null = handoff, resume?: string) {
    return createCodexAgentFactory({
      executable: process.execPath,
      baseEnv: testEnv(),
      launcherArgs: [FAKE_CODEX, '--account=chatgpt', `--log=${received()}`],
      cwd: dir,
      requestTimeoutMs: 5_000,
    })({
      instructions: 'Sei il worker.',
      ...(withHandoff ? { handoff: withHandoff } : {}),
      ...(resume ? { resume } : {}),
    });
  }

  type Message = {
    method?: string;
    id?: number;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  const messages = () => jsonLines<Message>(received());
  const elicitationAnswers = () =>
    messages()
      .filter((m) => m.method === undefined && (m.id ?? 0) >= 1000)
      .map((m) => m.result);

  it('registers ooc in the thread config as dotted keys, on start and on resume', async () => {
    const expected = {
      'mcp_servers.ooc.command': 'node',
      'mcp_servers.ooc.args': ['C:/ext/handoff-main.js'],
      'mcp_servers.ooc.env': OOC_ENV,
    };
    expect(handoffThreadConfig(handoff)).toEqual(expected);
    const started = await open();
    sessions.push(started);
    await started.runTurn('ciao', handlers().value).done;
    const resumed = await open(handoff, 'kept-3');
    sessions.push(resumed);
    await resumed.runTurn('ciao', handlers().value).done;
    const params = (method: string) => messages().find((m) => m.method === method)?.params;
    expect(params('thread/start')?.['config']).toEqual(expected);
    expect(params('thread/resume')?.['config']).toEqual(expected);
  });

  it('adds nothing to the thread without handoff tools', async () => {
    const session = await open(null);
    sessions.push(session);
    await session.runTurn('ciao', handlers().value).done;
    expect(
      JSON.stringify(messages().find((m) => m.method === 'thread/start')?.params),
    ).not.toContain('mcp_servers');
  });

  it('accepts the approval of an ooc call without asking the runtime, and surfaces the calls in order', async () => {
    const session = await open();
    sessions.push(session);
    const h = handlers();
    const result = await session.runTurn(`lavora\n${calls}`, h.value).done;
    expect(h.approvals).toEqual([]);
    expect(elicitationAnswers()).toEqual(
      Array(3).fill({ action: 'accept', content: {}, _meta: null }),
    );
    // The sub-agent's call (thread-child) was accepted too, but is not the main agent's.
    expect(result.handoffs).toEqual([
      { tool: 'report', arguments: report },
      { tool: 'review', arguments: review },
    ]);
  });

  it('keeps declining the approval of another MCP server, and reports nothing for it', async () => {
    const session = await open();
    sessions.push(session);
    const h = handlers();
    const result = await session.runTurn(`x\n[handoff@docs search {"q":1}]`, h.value).done;
    expect(h.approvals).toEqual([
      expect.objectContaining({ kind: 'mcpServer/elicitation/request' }) as unknown,
    ]);
    expect(elicitationAnswers()).toEqual([{ action: 'decline', content: null }]);
    expect(result.handoffs).toBeUndefined();
  });

  it('declines ooc too when no handoff tools were given for the session', async () => {
    const session = await open(null);
    sessions.push(session);
    const result = await session.runTurn('x\n[handoff report {}]', handlers().value).done;
    expect(elicitationAnswers()).toEqual([{ action: 'decline', content: null }]);
    expect(result.handoffs).toBeUndefined();
  });

  it('recognises only an mcp_tool_call approval of the server ooc', () => {
    const meta = { codex_approval_kind: 'mcp_tool_call' };
    const method = 'mcpServer/elicitation/request';
    expect(isHandoffApproval(method, { serverName: 'ooc', _meta: meta })).toBe(true);
    expect(isHandoffApproval(method, { serverName: 'docs', _meta: meta })).toBe(false);
    expect(
      isHandoffApproval(method, { serverName: 'ooc', _meta: { codex_approval_kind: 'x' } }),
    ).toBe(false);
    expect(isHandoffApproval(method, { serverName: 'ooc' })).toBe(false);
    expect(
      isHandoffApproval('item/commandExecution/requestApproval', {
        serverName: 'ooc',
        _meta: meta,
      }),
    ).toBe(false);
  });
});

describe('Antigravity (ACP)', () => {
  function open(
    config: { readOnly?: boolean } = {},
    withHandoff: HandoffTools | null = handoff,
    resume?: string,
  ) {
    return createAcpAgentFactory({
      executable: process.execPath,
      args: [FAKE_AGY, 'acp'],
      provider: 'Antigravity',
      cwd: dir,
      ...config,
    })({
      instructions: '[istruzioni]',
      ...(withHandoff ? { handoff: withHandoff } : {}),
      ...(resume ? { resume } : {}),
    });
  }

  const servers = [
    {
      name: 'ooc',
      command: 'node',
      args: ['C:/ext/handoff-main.js'],
      env: Object.entries(OOC_ENV).map(([name, value]) => ({ name, value })),
    },
  ];

  it('passes the server ooc in session/new and in session/load', async () => {
    const fresh = await open();
    sessions.push(fresh);
    expect((await fresh.runTurn('[mcp]', handlers().value).done).text).toContain(
      `mcp: ${JSON.stringify(servers)}`,
    );
    const loaded = await open({}, handoff, 'fake-1');
    sessions.push(loaded);
    expect((await loaded.runTurn('[mcp]', handlers().value).done).text).toContain(
      `mcp: ${JSON.stringify(servers)}`,
    );
  });

  it('passes no server without handoff tools', async () => {
    const session = await open({}, null);
    sessions.push(session);
    expect((await session.runTurn('[mcp]', handlers().value).done).text).toContain('mcp: []');
  });

  it('allows an ooc call even read-only without asking, and surfaces the calls in order with their rawInput', async () => {
    const session = await open({ readOnly: true });
    sessions.push(session);
    const h = handlers();
    const result = await session.runTurn(
      `lavora\n[handoff report ${JSON.stringify(report)}]\n[handoff review ${JSON.stringify({ verdict: 'approved' })}]`,
      h.value,
    ).done;
    expect(h.approvals).toEqual([]);
    expect(result.text).toContain('handoff report: allow');
    expect(result.text).toContain('handoff review: allow');
    // The last update of a call carries its input, with what Antigravity adds.
    expect(result.handoffs).toEqual([
      { tool: 'report', arguments: { ...report, toolSummary: 'report summary' } },
      { tool: 'review', arguments: { verdict: 'approved', toolSummary: 'review summary' } },
    ]);
  });

  it('still declines another server’s tool, and a tool that is not one of ours, read-only', async () => {
    const session = await open({ readOnly: true });
    sessions.push(session);
    const result = await session.runTurn(
      'x\n[handoff@docs search {"q":1}]\n[handoff nope {}]',
      handlers().value,
    ).done;
    expect(result.text).toContain('handoff search: deny');
    expect(result.text).toContain('handoff nope: deny');
    expect(result.handoffs).toBeUndefined();
  });

  it('asks the runtime about another server’s tool when the role is not read-only', async () => {
    const session = await open();
    sessions.push(session);
    const h = handlers();
    const result = await session.runTurn('x\n[handoff@docs search {}]', h.value).done;
    expect(h.approvals).toEqual([{ kind: 'other', summary: 'Run mcp_docs_search' }]);
    expect(result.handoffs).toBeUndefined();
  });

  it('declines ooc too when no handoff tools were given', async () => {
    const session = await open({ readOnly: true }, null);
    sessions.push(session);
    const result = await session.runTurn('x\n[handoff report {}]', handlers().value).done;
    expect(result.text).toContain('handoff report: deny');
    expect(result.handoffs).toBeUndefined();
  });
});
