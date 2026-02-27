const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');

async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const applied = await client.query('SELECT name FROM _migrations');
    const appliedNames = new Set(applied.rows.map(r => r.name));

    // Read migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('No migrations directory found');
      return;
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    for (const file of files) {
      const migration = require(path.join(migrationsDir, file));
      if (appliedNames.has(migration.name)) {
        continue;
      }

      console.log(`Running migration: ${migration.name}`);
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        console.log(`  ✓ ${migration.name} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${migration.name} failed:`, err.message);
        throw err;
      }
    }

    console.log('All migrations complete');
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
