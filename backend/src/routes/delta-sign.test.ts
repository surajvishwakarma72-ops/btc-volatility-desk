import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { signDelta } from './delta.js';

describe('signDelta', () => {
  it('matches the Delta HMAC scheme (GET + ts + path + query)', () => {
    const secret = 'testsecret';
    const ts = '1700000000';
    const path = '/v2/wallet/balances';
    const query = '';
    const expected = crypto.createHmac('sha256', secret).update('GET' + ts + path + query).digest('hex');
    expect(signDelta(secret, 'GET', ts, path, query)).toBe(expected);
  });
});
