const { Pool, types } = require('pg')

// Keep DATE columns as YYYY-MM-DD strings so JSON responses do not shift by timezone.
types.setTypeParser(types.builtins.DATE, (value) => value)

function buildConfig() {
  if (process.env.DATABASE_URL) {
    const ssl =
      process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined
    return { connectionString: process.env.DATABASE_URL, ssl }
  }

  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'hotel_booking',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  }
}

let pool

function getPool() {
  if (!pool) {
    pool = new Pool(buildConfig())
    pool.on('connect', () => {
      if (!getPool._logged) {
        console.log('✅ PostgreSQL connected:', buildConfig().database || 'via DATABASE_URL')
        getPool._logged = true
      }
    })
    pool.on('error', (err) => {
      console.error('❌ DB pool error:', err.message)
    })
  }
  return pool
}

async function withTransaction(fn) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

module.exports = { getPool, withTransaction }
