const { getHotelSetting, setHotelSetting } = require('./hotelSettings')

const SYSTEM_USER_NAME  = 'ระบบ'
const SYSTEM_USER_EMAIL = 'system@internal'

async function getSystemChatUserId(poolOrClient, hotelId) {
  const stored = await getHotelSetting(poolOrClient, hotelId, 'system_chat_user_id')
  if (!stored) return null
  const check = await poolOrClient.query(`SELECT id FROM users WHERE id = $1`, [stored])
  return check.rows[0]?.id || null
}

async function isSystemChatUser(poolOrClient, hotelId, userId) {
  const systemId = await getSystemChatUserId(poolOrClient, hotelId)
  return Boolean(systemId && String(systemId) === String(userId || ''))
}

async function migrateSystemMessagesIntoThread(poolOrClient, hotelId, systemUserId) {
  if (!hotelId || !systemUserId) return
  await poolOrClient.query(
    `UPDATE chat_messages
        SET user_id = $2
      WHERE hotel_id = $1
        AND sender_role = 'system'
        AND user_id IS DISTINCT FROM $2`,
    [hotelId, systemUserId]
  )
}

async function ensureSystemChatUser(poolOrClient, hotelId) {
  const existing = await getSystemChatUserId(poolOrClient, hotelId)
  if (existing) {
    await migrateSystemMessagesIntoThread(poolOrClient, hotelId, existing)
    return existing
  }

  const providerId = `hotel:${hotelId}`
  const existingUser = await poolOrClient.query(
    `SELECT id FROM users WHERE provider = 'system' AND provider_id = $1 LIMIT 1`,
    [providerId]
  )
  if (existingUser.rows[0]?.id) {
    await setHotelSetting(poolOrClient, hotelId, 'system_chat_user_id', existingUser.rows[0].id)
    await migrateSystemMessagesIntoThread(poolOrClient, hotelId, existingUser.rows[0].id)
    return existingUser.rows[0].id
  }

  const inserted = await poolOrClient.query(
    `INSERT INTO users (name, email, provider, provider_id, is_admin)
     VALUES ($1, $2, 'system', $3, false)
     RETURNING id`,
    [SYSTEM_USER_NAME, SYSTEM_USER_EMAIL, providerId]
  )
  const userId = inserted.rows[0]?.id
  if (!userId) throw new Error('Failed to create system chat user')

  await setHotelSetting(poolOrClient, hotelId, 'system_chat_user_id', userId)
  await migrateSystemMessagesIntoThread(poolOrClient, hotelId, userId)
  return userId
}

module.exports = {
  SYSTEM_USER_NAME,
  SYSTEM_USER_EMAIL,
  getSystemChatUserId,
  ensureSystemChatUser,
  isSystemChatUser,
  migrateSystemMessagesIntoThread,
}
