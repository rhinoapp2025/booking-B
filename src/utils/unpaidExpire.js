const { getHotelSettings } = require('./hotelSettings')
const { deletePaymentSlipByBookingId } = require('./bookingPaymentSlips')
const { emitBookingChanged } = require('./bookingEvents')
const { maybeCancelBookingInPms } = require('./kioskSaveBooking')

const DEFAULT_HOURS = 24
const MIN_HOURS = 1
const MAX_HOURS = 168

async function getUnpaidExpireSettings(poolOrClient, hotelId) {
  const map = await getHotelSettings(poolOrClient, hotelId, [
    'unpaid_auto_cancel_enabled',
    'auto_cancel_hours',
  ])
  const enabled = map.unpaid_auto_cancel_enabled !== 'false'
  let hours = Number(map.auto_cancel_hours)
  if (!Number.isFinite(hours) || hours < MIN_HOURS) hours = DEFAULT_HOURS
  if (hours > MAX_HOURS) hours = MAX_HOURS
  return { enabled, expireHours: hours }
}

function computeExpiresAt(createdAt, expireHours) {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return null
  return new Date(created.getTime() + expireHours * 60 * 60 * 1000)
}

function isBookingExpired(createdAt, expireHours, enabled) {
  if (!enabled || !createdAt) return false
  const expiresAt = computeExpiresAt(createdAt, expireHours)
  if (!expiresAt) return false
  return Date.now() >= expiresAt.getTime()
}

async function expireUnpaidBookings(poolOrClient, hotelId = null) {
  if (hotelId) {
    const { enabled, expireHours } = await getUnpaidExpireSettings(poolOrClient, hotelId)
    if (!enabled) return 0
    const due = await poolOrClient.query(
      `SELECT id, hotel_id, pms_resv_no FROM bookings
       WHERE hotel_id = $1
         AND status = 'awaiting_payment'
         AND created_at < NOW() - ($2::int * INTERVAL '1 hour')`,
      [hotelId, expireHours]
    )
    let cancelled = 0
    for (const row of due.rows) {
      if (row.pms_resv_no) {
        const pms = await maybeCancelBookingInPms(poolOrClient, row.hotel_id, row.id)
        if (pms?.error) {
          console.warn(`[unpaidExpire] PMS cancel failed for ${row.id}: ${pms.error}`)
          continue
        }
      }
      const result = await poolOrClient.query(
        `UPDATE bookings
         SET status = 'cancelled', cancelled_by = 'system', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND hotel_id = $2 AND status = 'awaiting_payment'
         RETURNING id, hotel_id`,
        [row.id, row.hotel_id]
      )
      if (!result.rows[0]) continue
      await deletePaymentSlipByBookingId(poolOrClient, row.id).catch(() => null)
      emitBookingChanged(row.hotel_id, { type: 'auto_cancelled', booking_id: row.id })
      cancelled += 1
    }
    return cancelled
  }

  const hotels = await poolOrClient.query(`SELECT id FROM hotels WHERE is_active = true`)
  let total = 0
  for (const row of hotels.rows) {
    total += await expireUnpaidBookings(poolOrClient, row.id)
  }
  return total
}

module.exports = {
  DEFAULT_HOURS, MIN_HOURS, MAX_HOURS,
  getUnpaidExpireSettings, computeExpiresAt, isBookingExpired, expireUnpaidBookings,
}
