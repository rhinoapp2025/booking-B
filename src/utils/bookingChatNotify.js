const { getChatNotifySettings } = require('./chatNotifySettings')
const { createChatMessage } = require('./chatMessages')
const { ensureSystemChatUser } = require('./systemChatUser')
const { pushAfterSystemChatNotify, pushAfterCustomerChatNotify } = require('./fcmPush')

function applyTemplate(template, ctx) {
  if (!template) return ''
  return String(template).replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? '')
}

async function loadBookingNotifyContext(poolOrClient, hotelId, bookingId) {
  const result = await poolOrClient.query(
    `SELECT b.id, b.check_in_date, b.check_out_date, b.status,
            u.name AS guest_name, b.user_id
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     WHERE b.id = $1 AND b.hotel_id = $2`,
    [bookingId, hotelId]
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    bookingId: String(row.id),
    checkInDate: String(row.check_in_date),
    checkOutDate: String(row.check_out_date),
    guestName: String(row.guest_name || ''),
    status: String(row.status),
    customerUserId: row.user_id,
  }
}

async function getHotelAdminSenderId(poolOrClient, hotelId) {
  const r = await poolOrClient.query(
    `SELECT user_id FROM hotel_admins WHERE hotel_id = $1 LIMIT 1`,
    [hotelId]
  )
  if (r.rows[0]?.user_id) return r.rows[0].user_id
  const fallback = await poolOrClient.query(
    `SELECT id FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1`
  )
  return fallback.rows[0]?.id || null
}

// แจ้งเตือนแอดมินทั้งหมดอยู่ใน thread "ระบบ" ไม่ปนกับแชทแขก
async function insertSystemChatMessage(poolOrClient, { hotelId, relatedUserId, body }) {
  const text = String(body || '').trim()
  if (!text) return null
  const systemUserId = await ensureSystemChatUser(poolOrClient, hotelId)
  return createChatMessage(poolOrClient, {
    hotelId,
    userId: systemUserId,
    senderRole: 'system',
    senderId: systemUserId,
    relatedUserId: relatedUserId || null,
    body: text,
  })
}

async function insertAdminChatMessage(poolOrClient, { hotelId, userId, body }) {
  const text = String(body || '').trim()
  if (!text) return null
  const adminId = await getHotelAdminSenderId(poolOrClient, hotelId)
  if (!adminId) return null
  return createChatMessage(poolOrClient, {
    hotelId, userId,
    senderRole: 'admin', senderId: adminId,
    body: text,
  })
}

async function notifyAdminNewBookingChat(poolOrClient, hotelId, bookingId) {
  try {
    const settings = await getChatNotifySettings(poolOrClient, hotelId)
    const ctx = await loadBookingNotifyContext(poolOrClient, hotelId, bookingId)
    if (!ctx?.customerUserId) return { ok: false, skipped: true }

    if (settings.newBookingEnabled) {
      const text = applyTemplate(settings.newBookingTemplate, ctx)
      const row = await insertSystemChatMessage(poolOrClient, {
        hotelId, relatedUserId: ctx.customerUserId, body: text,
      })
      if (row) {
        pushAfterSystemChatNotify(poolOrClient, hotelId, {
          title: 'มีการจองใหม่', body: text,
          relatedUserId: ctx.customerUserId, messageId: row.id, bookingId,
        }).catch(() => null)
      }
    }

    if (settings.confirmCustomerEnabled) {
      const text = applyTemplate(settings.confirmCustomerTemplate, ctx)
      const row = await insertAdminChatMessage(poolOrClient, {
        hotelId, userId: ctx.customerUserId, body: text,
      })
      if (row) {
        pushAfterCustomerChatNotify(poolOrClient, hotelId, ctx.customerUserId, {
          title: 'ยืนยันการจอง', body: text, messageId: row.id, bookingId,
        }).catch(() => null)
      }
    }
    return { ok: true }
  } catch (err) {
    console.error('notifyAdminNewBookingChat:', err.message)
    return { ok: false, error: err.message }
  }
}

async function notifyBookingCancelledChat(poolOrClient, hotelId, bookingId) {
  try {
    const settings = await getChatNotifySettings(poolOrClient, hotelId)
    if (!settings.cancelAdminEnabled && !settings.cancelCustomerEnabled) return { ok: false, skipped: true }
    const ctx = await loadBookingNotifyContext(poolOrClient, hotelId, bookingId)
    if (!ctx?.customerUserId) return { ok: false, skipped: true }

    if (settings.cancelAdminEnabled) {
      const text = applyTemplate(settings.cancelAdminTemplate, ctx)
      const row = await insertSystemChatMessage(poolOrClient, {
        hotelId, relatedUserId: ctx.customerUserId, body: text,
      })
      if (row) {
        pushAfterSystemChatNotify(poolOrClient, hotelId, {
          title: 'การจองถูกยกเลิก', body: text,
          relatedUserId: ctx.customerUserId, messageId: row.id, bookingId,
        }).catch(() => null)
      }
    }
    if (settings.cancelCustomerEnabled) {
      const text = applyTemplate(settings.cancelCustomerTemplate, ctx)
      const row = await insertAdminChatMessage(poolOrClient, {
        hotelId, userId: ctx.customerUserId, body: text,
      })
      if (row) {
        pushAfterCustomerChatNotify(poolOrClient, hotelId, ctx.customerUserId, {
          title: 'การจองถูกยกเลิก', body: text, messageId: row.id, bookingId,
        }).catch(() => null)
      }
    }
    return { ok: true }
  } catch (err) {
    console.error('notifyBookingCancelledChat:', err.message)
    return { ok: false, error: err.message }
  }
}

async function notifyAdminPaymentSlipChat(poolOrClient, hotelId, bookingId) {
  try {
    const settings = await getChatNotifySettings(poolOrClient, hotelId)
    if (!settings.slipAdminEnabled) return { ok: false, skipped: true }
    const ctx = await loadBookingNotifyContext(poolOrClient, hotelId, bookingId)
    if (!ctx?.customerUserId) return { ok: false, skipped: true }
    const text = applyTemplate(settings.slipAdminTemplate, ctx)
    const row = await insertSystemChatMessage(poolOrClient, {
      hotelId, relatedUserId: ctx.customerUserId, body: text,
    })
    if (!row) return { ok: false, skipped: true }
    pushAfterSystemChatNotify(poolOrClient, hotelId, {
      title: 'มีสลิปรอตรวจ', body: text,
      relatedUserId: ctx.customerUserId, messageId: row.id, bookingId,
    }).catch(() => null)
    return { ok: true, messageId: row.id }
  } catch (err) {
    console.error('notifyAdminPaymentSlipChat:', err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = {
  applyTemplate,
  loadBookingNotifyContext,
  insertSystemChatMessage,
  insertAdminChatMessage,
  notifyAdminNewBookingChat,
  notifyBookingCancelledChat,
  notifyAdminPaymentSlipChat,
}
