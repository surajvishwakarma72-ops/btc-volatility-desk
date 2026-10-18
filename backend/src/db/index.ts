import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;

export const pool = new pg.Pool({
  connectionString,
  ssl: connectionString?.includes('neon.tech') || connectionString?.includes('sslmode=require') 
    ? { rejectUnauthorized: false } 
    : undefined,
});

export const db = drizzle(pool, { schema });

export * from './schema.js';
