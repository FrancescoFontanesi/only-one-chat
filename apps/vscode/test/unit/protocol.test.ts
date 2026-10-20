import { describe, expect, it } from 'vitest';
import { parseHostMessage, parseWebviewMessage } from '../../src/webview/protocol.js';

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
