const { isSystemChatUser } = require('./systemChatUser')

async function assertChatUserAccess(poolOrClient, hotel, userId) {
  if (await isSystemChatUser(poolOrClient, hotel.id, userId)) return true
  const result = await poolOrClient.query(
    `SELECT 1 FROM bookings      WHERE hotel_id = $1 AND user_id = $2
     UNION ALL
     SELECT 1 FROM chat_messages WHERE hotel_id = $1 AND user_id = $2
     LIMIT 1`,
    [hotel.id, userId]
  )
  return result.rows.length > 0
}

function normalizeChatBody(value) {
  const body = String(value || '').trim()
  if (!body) return ''
  return body.length > 2000 ? body.slice(0, 2000) : body
}

async function requireChatUserAccess(poolOrClient, hotel, userId) {
  const ok = await assertChatUserAccess(poolOrClient, hotel, userId)
  if (!ok) {
    const err = new Error('ไม่มีสิทธิ์แชทกับผู้ใช้นี้')
    err.status = 403
    throw err
  }
}

module.exports = { assertChatUserAccess, requireChatUserAccess, normalizeChatBody }
