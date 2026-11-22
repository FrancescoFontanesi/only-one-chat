// The handoff server (ADR 0035): an MCP server on stdio whose tools are the
// handoffs between roles. It only validates the arguments against each tool's
// schema and answers: no state, no files, no network, no channel to the
// extension. The runtime reads the call from the CLI's own event stream, and
// validates it again with `validate`.
//
// The tools, [{ "name", "description", "inputSchema" }], come in the variable
// OOC_HANDOFF_TOOLS (or a file after --tools). Entry point: handoff-main.ts.
// No imports but Node's, so any Node runs it, VS Code's included.

import { readFileSync } from 'node:fs';

export interface HandoffTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
}

/** The subset of JSON Schema the handoff tools use. */
export interface Schema {
  readonly type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly enum?: readonly (string | number)[];
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A regular expression the whole string must match. */
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  /** On an array of objects: no two items share the value of this field. */
  readonly uniqueBy?: string;
}

/** The errors of `value` against `schema`, with their paths; empty when valid. */
export function validate(schema: Schema, value: unknown, at = '$'): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${at}: expected an object`];
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) errors.push(`${at}.${key}: required`);
    }
    for (const [key, child] of Object.entries(record)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(sub, child, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
    }
    return errors;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${at}: expected an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: at least ${String(schema.minItems)} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return [`${at}: at most ${String(schema.maxItems)} item(s)`];
    }
    if (schema.uniqueBy !== undefined) {
      const field = schema.uniqueBy;
      const seen = new Set<unknown>();
      value.forEach((item, i) => {
        const key = (item as Record<string, unknown> | null)?.[field];
        if (key === undefined) return;
        if (seen.has(key))
          errors.push(`${at}[${String(i)}].${field}: duplicate ${JSON.stringify(key)}`);
        seen.add(key);
      });
    }
    if (schema.items) {
      const items = schema.items;
      value.forEach((item, i) => errors.push(...validate(items, item, `${at}[${String(i)}]`)));
    }
    return errors;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`${at}: expected a string`];
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
      errors.push(`${at}: at least ${String(schema.minLength)} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: at most ${String(schema.maxLength)} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: must match ${schema.pattern}`);
    }
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) return [`${at}: expected an integer`];
  } else if (type === 'number') {
    if (typeof value !== 'number') return [`${at}: expected a number`];
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${at}: expected a boolean`];
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${at}: one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  return errors;
}

type Id = string | number | null;
type Reply = { result: unknown } | { error: { code: number; message: string } };

/** The answer to one JSON-RPC request; undefined for a notification. */
export function answer(
  tools: readonly HandoffTool[],
  method: string,
  params: unknown,
): Reply | undefined {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  switch (method) {
    case 'initialize':
      return {
        result: {
          // The client's version when it sends one: the server uses no newer feature.
          protocolVersion:
            typeof p['protocolVersion'] === 'string' ? p['protocolVersion'] : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ooc', version: '1' },
        },
      };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools } };
    case 'tools/call': {
      const tool = tools.find((t) => t.name === p['name']);
      if (!tool) return { error: { code: -32602, message: `unknown tool ${String(p['name'])}` } };
      const errors = validate(tool.inputSchema, p['arguments'] ?? {});
      // A tool error, not a protocol error: the model reads it and calls again.
      return {
        result:
          errors.length > 0
            ? {
                isError: true,
                content: [{ type: 'text', text: `Invalid arguments:\n${errors.join('\n')}` }],
              }
            : { content: [{ type: 'text', text: 'Received.' }] },
      };
    }
    default:
      return method.startsWith('notifications/')
        ? undefined
        : { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

function serve(tools: readonly HandoffTool[]): void {
  const handle = (line: string): void => {
    let message: { id?: Id; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.method !== 'string') return; // a response: we send no requests
    const reply = answer(tools, message.method, message.params);
    if (reply === undefined || message.id === undefined) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`);
  };
  // Split on "\n" only, not with readline: it also splits on U+2028/U+2029, which
  // JSON leaves unescaped in strings; the call was lost and the CLI waited (live, V1).
  let rest = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) handle(line);
  });
}

/** The tools from `OOC_HANDOFF_TOOLS` (JSON), or from the file after `--tools`. */
export function toolsFrom(argv: readonly string[], env: NodeJS.ProcessEnv): HandoffTool[] | null {
  const inline = env['OOC_HANDOFF_TOOLS'];
  if (inline) return JSON.parse(inline) as HandoffTool[];
  const at = argv.indexOf('--tools');
  const file = at >= 0 ? argv[at + 1] : undefined;
  return file ? (JSON.parse(readFileSync(file, 'utf8')) as HandoffTool[]) : null;
}

/** Runs the server on this process's stdio. */
export function main(): void {
  const tools = toolsFrom(process.argv, process.env);
  if (!tools) {
    process.stderr.write('handoff-server: set OOC_HANDOFF_TOOLS or pass --tools <file>\n');
    process.exit(2);
  }
  serve(tools);
}
