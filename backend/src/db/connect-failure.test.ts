import { describe, expect, it } from 'vitest';
import { isConnectFailure } from './index.js';

describe('isConnectFailure', () => {
  it.each([
    'Connection terminated due to connection timeout',
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
  ])('treats "%s" as an outage', (message) => {
    expect(isConnectFailure(new Error(message))).toBe(true);
  });

  it.each(['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'])('treats the %s code as an outage', (code) => {
    expect(isConnectFailure(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it('does not hide a real bug or a statement that may have run', () => {
    expect(isConnectFailure(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isConnectFailure(new Error('canceling statement due to statement timeout'))).toBe(false);
    expect(isConnectFailure(new Error('relation "fills" does not exist'))).toBe(false);
  });
});
