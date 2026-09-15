async function ensureFcmTokensSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (token)
    )
  `)
  await pool.query(`ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true`)
  await pool.query(`ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_enabled
      ON fcm_tokens (user_id) WHERE enabled = true
  `)
}

async function upsertFcmToken(pool, { userId, token, enabled = true, userAgent = null }) {
  const result = await pool.query(
    `INSERT INTO fcm_tokens (user_id, token, enabled, user_agent, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id, enabled = EXCLUDED.enabled,
       user_agent = COALESCE(EXCLUDED.user_agent, fcm_tokens.user_agent),
       updated_at = NOW()
     RETURNING id, user_id, token, enabled, created_at, updated_at`,
    [userId, token, enabled, userAgent]
  )
  return result.rows[0]
}

async function disableFcmToken(pool, { userId, token }) {
  const result = await pool.query(
    `UPDATE fcm_tokens SET enabled = false, updated_at = NOW()
     WHERE user_id = $1 AND token = $2 RETURNING id`,
    [userId, token]
  )
  return result.rows[0] || null
}

async function disableAllFcmTokensForUser(pool, userId) {
  const result = await pool.query(
    `UPDATE fcm_tokens SET enabled = false, updated_at = NOW()
     WHERE user_id = $1 AND enabled = true RETURNING id`,
    [userId]
  )
  return result.rowCount
}

async function deleteFcmToken(pool, token) {
  await pool.query(`DELETE FROM fcm_tokens WHERE token = $1`, [token])
}

async function getTokenPushStatus(pool, userId, token) {
  if (!token) return false
  const result = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM fcm_tokens WHERE user_id = $1 AND token = $2 AND enabled = true) AS enabled`,
    [userId, token]
  )
  return Boolean(result.rows[0]?.enabled)
}

async function getUserPushStatus(pool, userId) {
  const result = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM fcm_tokens WHERE user_id = $1 AND enabled = true) AS enabled`,
    [userId]
  )
  return Boolean(result.rows[0]?.enabled)
}

async function getEnabledTokensForUser(pool, userId) {
  const result = await pool.query(
    `SELECT token FROM fcm_tokens WHERE user_id = $1 AND enabled = true`,
    [userId]
  )
  return result.rows.map(r => r.token)
}

async function getEnabledTokensForHotelAdmins(pool, hotelId) {
  const result = await pool.query(
    `SELECT DISTINCT ft.token
     FROM fcm_tokens ft
     JOIN hotel_admins ha ON ha.user_id = ft.user_id AND ha.hotel_id = $1
     WHERE ft.enabled = true`,
    [hotelId]
  )
  return result.rows.map(r => r.token)
}

module.exports = {
  ensureFcmTokensSchema, upsertFcmToken, disableFcmToken,
  disableAllFcmTokensForUser, deleteFcmToken,
  getUserPushStatus, getTokenPushStatus,
  getEnabledTokensForUser, getEnabledTokensForHotelAdmins,
}
