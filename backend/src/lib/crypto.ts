import crypto from 'node:crypto';

/**
 * AES-256-GCM for secrets stored in the database (users' Delta API keys). The master key comes from
 * ENCRYPTION_MASTER_KEY (64 hex characters = 32 bytes) and is never stored in the database. Each value gets its own
 * random salt and IV; the key actually used is derived from the master key and that salt. Nothing is ever stored in plain text.
 */
export interface Sealed {
  data: string;
  salt: string;
  iv: string;
  tag: string;
}

export class MasterKeyMissing extends Error {
  constructor() {
    super('ENCRYPTION_MASTER_KEY is not set on the server (64 hex characters), so API keys cannot be stored safely');
  }
}

function master(): Buffer {
  const hex = process.env.ENCRYPTION_MASTER_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new MasterKeyMissing();
  return Buffer.from(hex, 'hex');
}

export const masterKeyConfigured = (): boolean => /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_MASTER_KEY ?? '');

const derive = (salt: Buffer): Buffer => Buffer.from(crypto.hkdfSync('sha256', master(), salt, 'desk-delta-key-v1', 32));

export function seal(plain: string): Sealed {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', derive(salt), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { data: data.toString('base64'), salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** Throws if the data, salt, IV or tag was changed, or the master key is different. */
export function open(s: Sealed): string {
  const d = crypto.createDecipheriv('aes-256-gcm', derive(Buffer.from(s.salt, 'base64')), Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8');
}
