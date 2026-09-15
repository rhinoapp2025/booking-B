const { getChatNotifySettings } = require('./chatNotifySettings')
const { pushAfterSystemChatNotify } = require('./fcmPush')
const { applyTemplate, loadBookingNotifyContext, insertSystemChatMessage } = require('./bookingChatNotify')

// แจ้งเตือนแอดมินในแชทระบบเมื่อใกล้เช็คอิน — แขกไม่ได้รับข้อความนี้
async function processUpcomingBookingReminders(pool) {
  const today = new Date().toISOString().split('T')[0]
  const hotels = await pool.query(`SELECT id FROM hotels WHERE is_active = true`)
  let sentAdmin = 0

  for (const hotel of hotels.rows) {
    const settings = await getChatNotifySettings(pool, hotel.id)
    if (!settings.upcomingAdminEnabled) continue

    const bookingsRes = await pool.query(
      `SELECT id, user_id, chat_admin_upcoming_sent_at
       FROM bookings
       WHERE hotel_id = $1
         AND check_in_date = $2
         AND status IN ('pending', 'confirmed')`,
      [hotel.id, today]
    )

    for (const row of bookingsRes.rows) {
      if (row.chat_admin_upcoming_sent_at) continue
      const ctx = await loadBookingNotifyContext(pool, hotel.id, row.id)
      if (!ctx) continue

      const text = applyTemplate(settings.upcomingAdminTemplate, ctx)
      const msg = await insertSystemChatMessage(pool, {
        hotelId: hotel.id, relatedUserId: row.user_id, body: text,
      }).catch(() => null)
      if (msg) {
        await pool.query(
          `UPDATE bookings SET chat_admin_upcoming_sent_at = NOW() WHERE id = $1`,
          [row.id]
        )
        pushAfterSystemChatNotify(pool, hotel.id, {
          title: 'ใกล้ถึงวันเช็คอิน', body: text,
          relatedUserId: row.user_id, messageId: msg.id, bookingId: row.id,
        }).catch(() => null)
        sentAdmin++
      }
    }
  }

  return { sentAdmin, sentCustomer: 0 }
}

module.exports = { processUpcomingBookingReminders }
