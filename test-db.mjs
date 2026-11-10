import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
pool.query('SELECT 1')
  .then(r => console.log('OK:', r.rows))
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => pool.end());