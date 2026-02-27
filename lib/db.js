const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: true },
      min: 2,
      max: 20,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

async function executeWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn(getPool());
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = 100 * Math.pow(2, i);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function query(text, params) {
  return executeWithRetry(pool => pool.query(text, params));
}

module.exports = { getPool, query, executeWithRetry };
