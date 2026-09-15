const { normalizeChatBody } = require('./chatAccess')
const { parseBase64Image, saveChatImage, deleteChatImageFile } = require('./chatImages')

async function createChatMessage(pool, {
  hotelId, userId, senderRole, senderId,
  body, imageData, imageMime, relatedUserId,
}) {
  const text = normalizeChatBody(body)
  let imageUrl = null
  let savedFilename = null

  if (imageData) {
    const parsed = parseBase64Image(imageData, imageMime)
    if (parsed?.error) {
      const err = new Error(parsed.error)
      err.status = 400
      throw err
    }
    savedFilename = await saveChatImage(hotelId, parsed.buffer, parsed.ext)
    imageUrl = savedFilename
  }

  if (!text && !imageUrl) {
    const err = new Error('กรุณาพิมพ์ข้อความหรือแนบรูป')
    err.status = 400
    throw err
  }

  try {
    const result = await pool.query(
      `INSERT INTO chat_messages (hotel_id, user_id, sender_role, sender_id, body, image_url, related_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, body, image_url, sender_role, sender_id, related_user_id, read_at, created_at`,
      [hotelId, userId, senderRole, senderId, text, imageUrl, relatedUserId || null]
    )
    return result.rows[0]
  } catch (err) {
    if (savedFilename) await deleteChatImageFile(hotelId, savedFilename).catch(() => null)
    throw err
  }
}

const CHAT_MESSAGE_LOAD_LIMIT = 500
const MESSAGE_FIELDS = 'id, body, image_url, sender_role, sender_id, related_user_id, read_at, created_at'
const MESSAGE_FIELDS_CM = `cm.id, cm.body, cm.image_url, cm.sender_role, cm.sender_id, cm.related_user_id, cm.read_at, cm.created_at`

function buildLatestMessagesQuery({ whereClause, extraSelect = '', extraJoin = '' }) {
  const selectExtra = extraSelect ? `, ${extraSelect}` : ''
  return `
    SELECT ${MESSAGE_FIELDS_CM}${selectExtra}
    FROM (
      SELECT id FROM chat_messages
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${CHAT_MESSAGE_LOAD_LIMIT}
    ) recent
    INNER JOIN chat_messages cm ON cm.id = recent.id
    ${extraJoin}
    ORDER BY cm.created_at ASC
  `
}

module.exports = { createChatMessage, CHAT_MESSAGE_LOAD_LIMIT, MESSAGE_FIELDS, buildLatestMessagesQuery }
