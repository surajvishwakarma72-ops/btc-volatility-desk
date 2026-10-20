import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;

const needsSsl = !!connectionString &&
  (connectionString.includes('neon.tech') || connectionString.includes('sslmode=require'));

export const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
    : undefined,
});

export const db = drizzle(pool, { schema });

export * from './schema.js';
