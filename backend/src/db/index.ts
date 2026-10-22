import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;

let normalizedConnectionString = connectionString;
if (normalizedConnectionString && normalizedConnectionString.includes('sslmode=require') && !normalizedConnectionString.includes('uselibpqcompat')) {
  normalizedConnectionString = normalizedConnectionString.replace('sslmode=require', 'sslmode=require&uselibpqcompat=true');
}

const needsSsl = !!normalizedConnectionString &&
  (normalizedConnectionString.includes('neon.tech') || normalizedConnectionString.includes('sslmode=require'));

export const pool = new pg.Pool({
  connectionString: normalizedConnectionString,
  ssl: needsSsl
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
    : undefined,
});

export const db = drizzle(pool, { schema });

export * from './schema.js';
