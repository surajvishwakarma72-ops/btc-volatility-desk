import { pool } from '../db/index.js';

async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        platform VARCHAR(20) NOT NULL DEFAULT 'android',
        sound_choice VARCHAR(50) NOT NULL DEFAULT 'chime',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    console.log('Successfully created push_devices table in Neon PostgreSQL!');
    process.exit(0);
  } catch (err) {
    console.error('Failed to create push_devices table:', err);
    process.exit(1);
  }
}

main();
