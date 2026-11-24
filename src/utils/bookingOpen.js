const { setHotelSetting } = require('./hotelSettings')

const BOOKING_OPEN_KEY = 'booking_open'

function isBookingOpenValue(value) {
  if (value == null || value === '') return true
  const s = String(value).trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(s)
}

function coerceBookingOpen(value) {
  if (value === true || value === 1 || value === '1') return true
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === 'on' || s === 'yes'
}

async function bookingOpenByHotelId(pool, hotelIds) {
  const map = new Map()
  const ids = [...new Set((hotelIds || []).map((id) => String(id || '')).filter(Boolean))]
  for (const id of ids) map.set(id, true)
  if (!ids.length) return map
  const result = await pool.query(
    `SELECT hotel_id, setting_value
     FROM hotel_settings
     WHERE setting_key = $1 AND hotel_id = ANY($2::uuid[])`,
    [BOOKING_OPEN_KEY, ids]
  )
  for (const row of result.rows) {
    map.set(String(row.hotel_id), isBookingOpenValue(row.setting_value))
  }
  return map
}

async function isHotelBookingOpen(pool, hotelId) {
  const map = await bookingOpenByHotelId(pool, [hotelId])
  return map.get(String(hotelId)) !== false
}

async function setHotelBookingOpen(pool, hotelId, open) {
  const enabled = coerceBookingOpen(open)
  await setHotelSetting(pool, hotelId, BOOKING_OPEN_KEY, enabled ? '1' : '0')
  await pool.query(
    `UPDATE hotels SET is_active = $2, updated_at = NOW() WHERE id = $1`,
    [hotelId, enabled]
  )
  return enabled
}

module.exports = {
  BOOKING_OPEN_KEY,
  isBookingOpenValue,
  coerceBookingOpen,
  bookingOpenByHotelId,
  isHotelBookingOpen,
  setHotelBookingOpen,
}
