/**
 * In-memory mock DB for booking slot validation tests.
 * Handles SQL used by validateBookingSlot / finalizeBookingSlotWithServices.
 */
function createMockBookingDb(config = {}) {
  const shopId = config.shopId ?? 1
  const state = {
    settings: {
      shop_open_hour: '9',
      shop_last_booking_hour: '18',
      booking_slot_hours: '2',
      extend_booking_by_services: 'false',
      extend_booking_past_close: 'false',
      ...config.settings,
    },
    /** @type {Record<string, Array<object>>} */
    dayHours: { ...(config.dayHours || {}) },
    /** @type {Array<object>} */
    bookings: [...(config.bookings || [])],
    /** @type {Record<string, Array<object>>} */
    blocks: { ...(config.blocks || {}) },
    /** @type {Record<string|number, { duration_min: number }>} */
    options: {
      1: { duration_min: 60 },
      2: { duration_min: 90 },
      3: { duration_min: 150 },
      ...(config.options || {}),
    },
  }

  let nextBookingId = config.nextBookingId ?? 100

  function normalizeSql(sql) {
    return String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
  }

  function queryBookingsForDate(params, excludeId = null) {
    const sid = params[0]
    const date = params[1]
    let rows = state.bookings.filter(
      (b) =>
        b.shop_id === sid
        && String(b.booking_date).slice(0, 10) === String(date).slice(0, 10)
        && b.status !== 'cancelled'
    )
    if (excludeId != null) {
      rows = rows.filter((b) => String(b.id) !== String(excludeId))
    }
    return rows.map((b) => ({
      id: b.id,
      start_hour: b.start_hour,
      start_minute: b.start_minute ?? 0,
      end_hour: b.end_hour,
      end_minute: b.end_minute ?? 0,
      status: b.status ?? 'pending',
    }))
  }

  async function query(sql, params = []) {
    const s = normalizeSql(sql)

    if (s.includes('from booking_day_hours') && s.includes('schedule_date = $2')) {
      const date = params[1]
      const rows = (state.dayHours[date] || []).map((w, i) => ({
        id: w.id ?? i + 1,
        schedule_date: date,
        start_hour: w.start_hour,
        start_minute: w.start_minute ?? 0,
        end_hour: w.end_hour,
        end_minute: w.end_minute ?? 0,
      }))
      return { rows }
    }

    if (s.includes('from shop_settings') && s.includes('any($2')) {
      const keys = params[1]
      const rows = (keys || [])
        .filter((k) => state.settings[k] != null)
        .map((k) => ({ setting_key: k, setting_value: state.settings[k] }))
      return { rows }
    }

    if (s.includes('from shop_settings') && s.includes('setting_key = $2')) {
      const key = params[1]
      const val = state.settings[key]
      return { rows: val != null ? [{ setting_value: val }] : [] }
    }

    if (s.includes('from bookings') && s.includes('booking_date = $2')) {
      const excludeMatch = s.includes('id !=')
      const excludeId = excludeMatch ? params[2] : null
      return { rows: queryBookingsForDate(params, excludeId) }
    }

    if (s.includes('from booking_blocks')) {
      const date = params[1]
      return { rows: state.blocks[date] || [] }
    }

    if (s.includes('sum(duration_min)') && s.includes('from nailoption')) {
      const ids = params.slice(1)
      const total = ids.reduce((sum, id) => sum + (state.options[id]?.duration_min ?? 0), 0)
      return { rows: [{ total }] }
    }

    return { rows: [] }
  }

  function addBooking(booking) {
    const row = {
      id: booking.id ?? nextBookingId++,
      shop_id: shopId,
      status: 'pending',
      start_minute: 0,
      end_minute: 0,
      ...booking,
    }
    state.bookings.push(row)
    return row
  }

  function updateBooking(id, patch) {
    const row = state.bookings.find((b) => String(b.id) === String(id))
    if (!row) return null
    Object.assign(row, patch)
    return row
  }

  function setSetting(key, value) {
    state.settings[key] = String(value)
  }

  return { query, state, addBooking, updateBooking, setSetting, shopId }
}

module.exports = { createMockBookingDb }
