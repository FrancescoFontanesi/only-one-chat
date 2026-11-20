import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { answer, toolsFrom, validate, type HandoffTool } from '../src/handoff-server.js';

const report: HandoffTool = {
  name: 'report',
  description: 'The report of the work.',
  inputSchema: {
    type: 'object',
    required: ['outcome', 'text'],
    additionalProperties: false,
    properties: {
      outcome: { type: 'string', enum: ['done', 'partial', 'blocked'] },
      text: { type: 'string', minLength: 1 },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'status'],
          properties: {
            id: { type: 'integer' },
            status: { type: 'string', enum: ['verified', 'not_verified', 'not_met'] },
          },
        },
      },
    },
  },
};

describe('validate', () => {
  it('accepts a valid value and lists every error of an invalid one', () => {
    expect(
      validate(report.inputSchema, {
        outcome: 'done',
        text: 'ok',
        criteria: [{ id: 1, status: 'verified' }],
      }),
    ).toEqual([]);
    expect(
      validate(report.inputSchema, {
        outcome: 'completato',
        text: ' ',
        extra: 1,
        criteria: [{ id: 'a', status: 'verificato' }],
      }),
    ).toEqual([
      '$.outcome: one of "done", "partial", "blocked"',
      '$.text: at least 1 character(s)',
      '$.extra: not allowed',
      '$.criteria[0].id: expected an integer',
      '$.criteria[0].status: one of "verified", "not_verified", "not_met"',
    ]);
    expect(validate(report.inputSchema, [])).toEqual(['$: expected an object']);
  });

  it('checks a pattern against the whole string', () => {
    const id = { type: 'string', pattern: '^C\\d+$' } as const;
    expect(validate(id, 'C12')).toEqual([]);
    expect(validate(id, 'c1')).toEqual(['$: must match ^C\\d+$']);
    expect(validate(id, 'C1 and more')).toEqual(['$: must match ^C\\d+$']);
  });
});

describe('answer', () => {
  it('lists the tools and answers a call: received, or the errors for the model', () => {
    expect(answer([report], 'tools/list', {})).toEqual({ result: { tools: [report] } });
    expect(
      answer([report], 'tools/call', {
        name: 'report',
        arguments: { outcome: 'done', text: 'ok' },
      }),
    ).toEqual({ result: { content: [{ type: 'text', text: 'Received.' }] } });
    expect(
      answer([report], 'tools/call', { name: 'report', arguments: { outcome: 'x' } }),
    ).toMatchObject({ result: { isError: true } });
    expect(answer([report], 'tools/call', { name: 'nope' })).toMatchObject({
      error: { code: -32602 },
    });
    expect(answer([report], 'notifications/initialized', {})).toBeUndefined();
    expect(answer([report], 'resources/list', {})).toMatchObject({ error: { code: -32601 } });
  });
});

describe('the server process', () => {
  it('reads its tools from OOC_HANDOFF_TOOLS, or from the file after --tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ooc-handoff-'));
    const file = join(dir, 'tools.json');
    writeFileSync(file, JSON.stringify([report]));
    expect(toolsFrom(['node', 'x', '--tools', file], {})).toEqual([report]);
    expect(toolsFrom([], { OOC_HANDOFF_TOOLS: JSON.stringify([report]) })).toEqual([report]);
    expect(toolsFrom([], {})).toBeNull();
  });

  it('speaks MCP on stdio with the tools of its environment', async () => {
    const main = fileURLToPath(new URL('../src/handoff-main.ts', import.meta.url));
    const resolver = fileURLToPath(new URL('../../../dev/ts-resolve.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolver).href, main], {
      stdio: 'pipe',
      env: { ...process.env, OOC_HANDOFF_TOOLS: JSON.stringify([report]) },
    });
    const replies: unknown[] = [];
    let buffer = '';
    const got = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) replies.push(JSON.parse(line));
        if (replies.length === 2) resolve();
      });
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      // U+2028/U+2029 stay unescaped in JSON: the line must not split on them (live, V1).
      params: { name: 'report', arguments: { outcome: 'blocked', text: 'no more ' } },
    });
    await got;
    child.kill();
    expect(replies).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ooc', version: '1' },
        },
      },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Received.' }] } },
    ]);
  });
});
