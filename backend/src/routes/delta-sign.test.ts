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

  it('hashes a non-empty, ?-prefixed query exactly as given', () => {
    const secret = 'testsecret';
    const ts = '1700000000';
    const path = '/v2/orders';
    const q = '?product_id=27&state=open';
    const expected = crypto.createHmac('sha256', secret).update('GET' + ts + path + q).digest('hex');
    expect(signDelta(secret, 'GET', ts, path, q)).toBe(expected);
    // pure function: it signs whatever is passed, so the ?-prefixed form differs from the bare form
    expect(signDelta(secret, 'GET', ts, path, q)).not.toBe(signDelta(secret, 'GET', ts, path, 'product_id=27&state=open'));
  });
});
