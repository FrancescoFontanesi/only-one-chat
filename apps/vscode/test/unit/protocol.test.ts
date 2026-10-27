import { describe, expect, it } from 'vitest';
import {
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
