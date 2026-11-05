import { describe, expect, it } from 'vitest';
import {
  effortFor,
  MAX_TEXT_LENGTH,
  parseHostMessage,
  parseWebviewMessage,
} from '../../src/webview/protocol.js';

describe('parseWebviewMessage', () => {
  it('accepts the known messages', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'ping', id: 7 })).toEqual({ type: 'ping', id: 7 });
  });

  it('drops extra fields instead of forwarding them', () => {
    expect(parseWebviewMessage({ type: 'ready', command: 'rm -rf /' })).toEqual({ type: 'ready' });
  });

  it.each([
    null,
    undefined,
    'ready',
    42,
    {},
    { type: 'unknown' },
    { type: 'ping' },
    { type: 'ping', id: '7' },
    { type: 'ping', id: 1.5 },
    { type: 'ping', id: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects %j', (value) => {
    expect(parseWebviewMessage(value)).toBeUndefined();
  });
});

describe('parseWebviewMessage: the chat', () => {
  it('accepts a message to the leader, decisions, stop, mode and a new chat', () => {
    expect(parseWebviewMessage({ type: 'send', text: 'ciao' })).toEqual({
      type: 'send',
      text: 'ciao',
    });
    expect(parseWebviewMessage({ type: 'decide', id: 'a-1', action: 'approve' })).toEqual({
      type: 'decide',
      id: 'a-1',
      action: 'approve',
    });
    expect(
      parseWebviewMessage({ type: 'decide', id: 'a-2', action: 'edit', text: 'nuovo brief' }),
    ).toEqual({ type: 'decide', id: 'a-2', action: 'edit', text: 'nuovo brief' });
    expect(parseWebviewMessage({ type: 'stop' })).toEqual({ type: 'stop' });
    expect(parseWebviewMessage({ type: 'handoff' })).toEqual({ type: 'handoff' });
    expect(parseWebviewMessage({ type: 'setMode', mode: 'auto' })).toEqual({
      type: 'setMode',
      mode: 'auto',
    });
    expect(parseWebviewMessage({ type: 'newChat' })).toEqual({ type: 'newChat' });
  });

  it.each([
    { type: 'send', text: '' },
    { type: 'send', text: '   ' },
    { type: 'send', text: 42 },
    { type: 'send', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
    { type: 'decide', id: 'a-1', action: 'run' },
    { type: 'decide', id: '../../etc', action: 'approve' },
    { type: 'decide', id: 'a-1', action: 'edit' },
    { type: 'decide', id: 'a-1', action: 'edit', text: '' },
    { type: 'setMode', mode: 'yolo' },
  ])('rejects %j', (value) => {
    expect(parseWebviewMessage(value)).toBeUndefined();
  });
});

describe('parseWebviewMessage: composer and roles (ADR 0012)', () => {
  it('accepts the recipient and route of a message, and a role', () => {
    expect(parseWebviewMessage({ type: 'send', text: 'x', to: 'implementer' })).toEqual({
      type: 'send',
      text: 'x',
      to: 'implementer',
    });
    expect(parseWebviewMessage({ type: 'send', text: 'x', route: 'delega' })).toEqual({
      type: 'send',
      text: 'x',
      route: 'delega',
    });
    const role = {
      type: 'setRole',
      role: 'implementer',
      cli: 'claude',
      model: 'claude-haiku-4-5-20251001',
      effort: '',
      permission: 'ask',
    };
    expect(parseWebviewMessage({ ...role, extra: 1 })).toEqual(role);
    expect(parseWebviewMessage({ type: 'refreshModels' })).toEqual({ type: 'refreshModels' });
  });

  it.each([
    { type: 'send', text: 'x', to: 'gateway' },
    { type: 'send', text: 'x', route: 'rm' },
    { type: 'setRole', role: 'boss', cli: 'codex', model: 'm', effort: 'low', permission: 'auto' },
    {
      type: 'setRole',
      role: 'leader',
      cli: 'gemini',
      model: 'm',
      effort: 'low',
      permission: 'auto',
    },
    {
      type: 'setRole',
      role: 'leader',
      cli: 'codex',
      model: '--yolo',
      effort: 'low',
      permission: 'auto',
    },
    {
      type: 'setRole',
      role: 'leader',
      cli: 'codex',
      model: 'm',
      effort: 'LOW',
      permission: 'auto',
    },
    { type: 'setRole', role: 'leader', cli: 'codex', model: 'm', effort: 'low', permission: 'all' },
  ])('rejects %j', (value) => {
    expect(parseWebviewMessage(value)).toBeUndefined();
  });

  it('accepts a setting for the user or the folder, and its removal', () => {
    expect(
      parseWebviewMessage({
        type: 'setSetting',
        key: 'notifications.usageThreshold',
        value: 70,
        target: 'user',
      }),
    ).toEqual({
      type: 'setSetting',
      key: 'notifications.usageThreshold',
      value: 70,
      target: 'user',
    });
    expect(
      parseWebviewMessage({ type: 'setSetting', key: 'allowedCommands', target: 'workspace' }),
    ).toEqual({ type: 'setSetting', key: 'allowedCommands', target: 'workspace' });
    for (const bad of [
      { type: 'setSetting', key: '../x', value: 1, target: 'user' },
      { type: 'setSetting', key: 'fake', value: true, target: 'machine' },
      { type: 'setSetting', key: 'fake', value: { a: 1 }, target: 'user' },
      { type: 'setSetting', key: 'allowedCommands', value: [1], target: 'user' },
    ]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
  });

  it('keeps an effort the model supports, else its default or medium', () => {
    const model = { id: 'm', name: 'M', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'low' };
    expect(effortFor(model, 'ultra')).toBe('ultra');
    expect(effortFor(model, 'max')).toBe('low');
    expect(effortFor({ ...model, defaultEffort: null }, 'max')).toBe('medium');
    expect(effortFor({ ...model, efforts: [] }, 'low')).toBe('');
    expect(effortFor(undefined, 'high')).toBe('high');
  });
});

describe('parseHostMessage', () => {
  it('accepts a pong', () => {
    expect(parseHostMessage({ type: 'pong', id: 1, receivedAt: 'now' })).toEqual({
      type: 'pong',
      id: 1,
      receivedAt: 'now',
    });
  });

  it.each([null, { type: 'status' }, { type: 'pong', id: 1 }, { type: 'other' }])(
    'rejects %j',
    (value) => {
      expect(parseHostMessage(value)).toBeUndefined();
    },
  );
});
