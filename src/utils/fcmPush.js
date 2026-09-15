const { getMessaging, isFcmConfigured } = require('./firebaseAdmin')
const { deleteFcmToken, getEnabledTokensForHotelAdmins, getEnabledTokensForUser } = require('./fcmTokens')

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
])

function truncateBody(text, max = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function getFrontendOrigin() {
  const origins = String(process.env.FRONTEND_URL || '').split(',')
    .map(v => v.trim().replace(/\/$/, '')).filter(Boolean)
  return origins.find(u => /^https:\/\//i.test(u) && !/localhost|127\.0\.0\.1/i.test(u)) || origins[0] || ''
}

function toAbsoluteUrl(path) {
  const value = String(path || '/')
  if (/^https?:\/\//i.test(value)) return value
  const origin = getFrontendOrigin()
  return origin ? `${origin}${value.startsWith('/') ? value : `/${value}`}` : value
}

function buildNotificationPayload({ title, body, url, data = {} }) {
  const absoluteUrl = toAbsoluteUrl(url)
  const payloadData = { ...data, title: String(title || 'แจ้งเตือน').trim(), body: truncateBody(body), url: absoluteUrl }
  return {
    data: Object.fromEntries(Object.entries(payloadData).map(([k, v]) => [k, String(v ?? '')])),
    webpush: { headers: { Urgency: 'high', TTL: '86400' }, fcmOptions: { link: absoluteUrl } },
  }
}

async function removeInvalidTokens(pool, tokens, responses) {
  if (!responses?.length) return
  await Promise.all(responses.map(async (r, i) => {
    if (!r.success && INVALID_TOKEN_CODES.has(r.error?.code)) {
      await deleteFcmToken(pool, tokens[i]).catch(() => null)
    }
  }))
}

async function sendPushToTokens(pool, tokens, payload) {
  const unique = [...new Set((tokens || []).filter(Boolean))]
  if (!unique.length) return { ok: true, sent: 0, skipped: true, reason: 'no_tokens' }
  if (!isFcmConfigured()) return { ok: false, skipped: true, reason: 'fcm_not_configured' }
  const messaging = getMessaging()
  if (!messaging) return { ok: false, skipped: true, reason: 'fcm_not_configured' }
  const message = buildNotificationPayload(payload)
  try {
    const response = await messaging.sendEachForMulticast({ tokens: unique, ...message })
    await removeInvalidTokens(pool, unique, response.responses)
    return { ok: true, sent: response.successCount, failed: response.failureCount }
  } catch (err) {
    console.error('sendPushToTokens:', err.message)
    return { ok: false, error: err.message }
  }
}

async function sendPushToUser(pool, userId, payload) {
  const tokens = await getEnabledTokensForUser(pool, userId)
  return sendPushToTokens(pool, tokens, payload)
}

async function sendPushToHotelAdmins(pool, hotelId, payload) {
  const tokens = await getEnabledTokensForHotelAdmins(pool, hotelId)
  return sendPushToTokens(pool, tokens, payload)
}

async function getHotelPushContext(pool, hotelId) {
  const result = await pool.query(`SELECT slug, name FROM hotels WHERE id = $1 LIMIT 1`, [hotelId])
  return result.rows[0] || null
}

function buildChatPushPayload({ hotelSlug, title, body, userId, target = 'admin', bookingId = null }) {
  const base = String(hotelSlug || 'default')
  const url = target === 'customer' ? `/${base}/chat` : userId ? `/${base}/chat?userId=${userId}` : `/${base}/chat`
  const data = { type: 'chat', hotelSlug: base, userId: userId ? String(userId) : '', target }
  if (bookingId) data.bookingId = String(bookingId)
  return { title, body, url, data }
}

async function pushAfterSystemChatNotify(pool, hotelId, { body, relatedUserId, title = 'แจ้งเตือนระบบ', messageId = null, bookingId = null }) {
  const hotel = await getHotelPushContext(pool, hotelId)
  if (!hotel) return { ok: false, skipped: true }
  const { ensureSystemChatUser } = require('./systemChatUser')
  const systemUserId = await ensureSystemChatUser(pool, hotelId)
  const payload = buildChatPushPayload({
    hotelSlug: hotel.slug,
    title: `${title} · ${hotel.name}`,
    body,
    userId: systemUserId,
    target: 'admin',
    bookingId,
  })
  if (messageId) payload.data.messageId = String(messageId)
  if (relatedUserId) payload.data.relatedUserId = String(relatedUserId)
  return sendPushToHotelAdmins(pool, hotelId, payload)
}

async function pushAfterCustomerChatNotify(pool, hotelId, userId, { body, title = 'แจ้งเตือนจากโรงแรม', messageId = null, bookingId = null }) {
  const hotel = await getHotelPushContext(pool, hotelId)
  if (!hotel || !userId) return { ok: false, skipped: true }
  const payload = buildChatPushPayload({ hotelSlug: hotel.slug, title: `${title} · ${hotel.name}`, body, target: 'customer', bookingId })
  if (messageId) payload.data.messageId = String(messageId)
  return sendPushToUser(pool, userId, payload)
}

async function pushAfterCustomerChatMessage(pool, hotelId, { customerId, customerName, body, imageUrl = null, messageId = null }) {
  const hotel = await getHotelPushContext(pool, hotelId)
  if (!hotel || !customerId) return { ok: false, skipped: true }
  const name = String(customerName || '').trim() || await pool.query(`SELECT name FROM users WHERE id = $1 LIMIT 1`, [customerId]).then(r => r.rows[0]?.name || 'แขก')
  const preview = String(body || '').trim() || (imageUrl ? '[รูปภาพ]' : 'ส่งข้อความถึงคุณ')
  const payload = buildChatPushPayload({ hotelSlug: hotel.slug, title: `ข้อความใหม่จาก ${name}`, body: preview, userId: customerId, target: 'admin' })
  if (messageId) payload.data.messageId = String(messageId)
  return sendPushToHotelAdmins(pool, hotelId, payload)
}

async function pushAfterAdminChatMessage(pool, hotelId, customerId, { body, imageUrl = null, messageId = null }) {
  const hotel = await getHotelPushContext(pool, hotelId)
  if (!hotel || !customerId) return { ok: false, skipped: true }
  const preview = String(body || '').trim() || (imageUrl ? '[รูปภาพ]' : 'ส่งข้อความถึงคุณ')
  const payload = buildChatPushPayload({ hotelSlug: hotel.slug, title: `ข้อความใหม่ · ${hotel.name}`, body: preview, target: 'customer' })
  if (messageId) payload.data.messageId = String(messageId)
  return sendPushToUser(pool, customerId, payload)
}

module.exports = {
  isFcmConfigured, sendPushToTokens, sendPushToUser, sendPushToHotelAdmins,
  pushAfterSystemChatNotify, pushAfterCustomerChatNotify,
  pushAfterCustomerChatMessage, pushAfterAdminChatMessage, buildChatPushPayload,
}
