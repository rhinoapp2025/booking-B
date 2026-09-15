const { getHotelSettings } = require('./hotelSettings')

const DAY_WINDOWS = [7, 14, 30, 60, 120, 360]
const MAX_CALENDAR_DAYS = 360
const MAX_BULK_DAYS = 366 * 3

function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + days))
  return dt.toISOString().slice(0, 10)
}

function stayDates(checkIn, checkOut) {
  const from = String(checkIn || '').slice(0, 10)
  const to = String(checkOut || '').slice(0, 10)
  const out = []
  if (!from || !to || to <= from) return out
  let d = from
  while (d < to) {
    out.push(d)
    d = addDaysYmd(d, 1)
  }
  return out
}

function listDatesInclusive(fromYmd, days) {
  const n = Number(days)
  const out = []
  if (!fromYmd || !Number.isFinite(n) || n < 1) return out
  for (let i = 0; i < n; i++) out.push(addDaysYmd(fromYmd, i))
  return out
}

function daysInclusive(fromYmd, toYmd) {
  const start = String(fromYmd || '').slice(0, 10)
  const end = String(toYmd || '').slice(0, 10)
  if (!start || !end || end < start) return 0
  const [sy, sm, sd] = start.split('-').map(Number)
  const [ey, em, ed] = end.split('-').map(Number)
  const ms = Date.UTC(ey, (em || 1) - 1, ed || 1) - Date.UTC(sy, (sm || 1) - 1, sd || 1)
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.round(ms / 86400000) + 1
}

function weekdayMon0(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const js = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
  return (js + 6) % 7
}

function parseWeekdays(raw) {
  if (!Array.isArray(raw) || !raw.length) return [0, 1, 2, 3, 4, 5, 6]
  const set = new Set()
  for (const item of raw) {
    const n = Number(item)
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n)
  }
  return set.size ? [...set] : [0, 1, 2, 3, 4, 5, 6]
}

function filterDatesByWeekday(dates, weekdays) {
  const allow = new Set(parseWeekdays(weekdays))
  return dates.filter((d) => allow.has(weekdayMon0(d)))
}

const ROOM_HOLD_SQL = `b.status NOT IN ('cancelled', 'checked_out', 'no_show')`

async function getLocalVacantByTypeDate(pool, hotelId, dates) {
  if (!dates.length) return {}
  const rooms = await pool.query(
    `SELECT r.id, rt.name AS room_type_name
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.hotel_id = $1 AND r.status = 'available' AND rt.is_active = true`,
    [hotelId]
  )
  const holds = await pool.query(
    `SELECT br.room_id,
            to_char(b.check_in_date, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out_date, 'YYYY-MM-DD') AS check_out
     FROM booking_rooms br
     JOIN bookings b ON b.id = br.booking_id
     WHERE b.hotel_id = $1 AND ${ROOM_HOLD_SQL}`,
    [hotelId]
  )
  const holdsByRoom = {}
  for (const row of holds.rows) {
    if (!holdsByRoom[row.room_id]) holdsByRoom[row.room_id] = []
    holdsByRoom[row.room_id].push(row)
  }
  const vacant = {}
  for (const room of rooms.rows) {
    if (!vacant[room.room_type_name]) {
      vacant[room.room_type_name] = Object.fromEntries(dates.map((d) => [d, 0]))
    }
    const blocked = holdsByRoom[room.id] || []
    for (const d of dates) {
      const taken = blocked.some((h) => h.check_in <= d && h.check_out > d)
      if (!taken) vacant[room.room_type_name][d] += 1
    }
  }
  return vacant
}

async function assertPmsOn(pool, hotelId) {
  const settings = await getHotelSettings(pool, hotelId, ['kiosk_enabled'])
  if (settings.kiosk_enabled !== 'true') {
    const err = new Error('Channel manager ใช้ได้เฉพาะโหมด PMS')
    err.status = 409
    throw err
  }
}

async function listRatePlans(pool, hotelId) {
  const result = await pool.query(
    `SELECT id, name, is_active, includes_breakfast, created_at
     FROM rate_plans
     WHERE hotel_id = $1
     ORDER BY lower(name) ASC`,
    [hotelId]
  )
  return result.rows
}

function parseIncludesBreakfast(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

async function createRatePlan(pool, hotelId, name, opts = {}) {
  const trimmed = String(name || '').trim()
  if (!trimmed) {
    const err = new Error('กรอกชื่อเรทแพลน')
    err.status = 400
    throw err
  }
  const includesBreakfast = parseIncludesBreakfast(opts.includes_breakfast)
  try {
    const result = await pool.query(
      `INSERT INTO rate_plans (hotel_id, name, includes_breakfast)
       VALUES ($1, $2, $3)
       RETURNING id, name, is_active, includes_breakfast, created_at`,
      [hotelId, trimmed, includesBreakfast]
    )
    return result.rows[0]
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('มีเรทแพลนชื่อนี้อยู่แล้ว')
      dup.status = 409
      throw dup
    }
    throw err
  }
}

async function updateRatePlan(pool, hotelId, planId, patch = {}) {
  const fields = []
  const params = [planId, hotelId]
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const trimmed = String(patch.name || '').trim()
    if (!trimmed) {
      const err = new Error('กรอกชื่อเรทแพลน')
      err.status = 400
      throw err
    }
    params.push(trimmed)
    fields.push(`name = $${params.length}`)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'is_active')) {
    params.push(patch.is_active !== false)
    fields.push(`is_active = $${params.length}`)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'includes_breakfast')) {
    params.push(parseIncludesBreakfast(patch.includes_breakfast))
    fields.push(`includes_breakfast = $${params.length}`)
  }
  if (!fields.length) {
    const err = new Error('ไม่มีข้อมูลที่จะแก้')
    err.status = 400
    throw err
  }
  fields.push('updated_at = NOW()')
  const result = await pool.query(
    `UPDATE rate_plans SET ${fields.join(', ')}
     WHERE id = $1 AND hotel_id = $2
     RETURNING id, name, is_active, includes_breakfast, created_at`,
    params
  )
  if (!result.rows[0]) {
    const err = new Error('ไม่พบเรทแพลน')
    err.status = 404
    throw err
  }
  return result.rows[0]
}

async function deleteRatePlan(pool, hotelId, planId) {
  const result = await pool.query(
    `DELETE FROM rate_plans WHERE id = $1 AND hotel_id = $2 RETURNING id`,
    [planId, hotelId]
  )
  if (!result.rows[0]) {
    const err = new Error('ไม่พบเรทแพลน')
    err.status = 404
    throw err
  }
}

async function attachRatePlan(pool, hotelId, roomTypeId, ratePlanId) {
  const plan = await pool.query(
    `SELECT id FROM rate_plans WHERE id = $1 AND hotel_id = $2`,
    [ratePlanId, hotelId]
  )
  if (!plan.rows[0]) {
    const err = new Error('ไม่พบเรทแพลน')
    err.status = 404
    throw err
  }
  const type = await pool.query(
    `SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2`,
    [roomTypeId, hotelId]
  )
  if (!type.rows[0]) {
    const err = new Error('ไม่พบประเภทห้อง')
    err.status = 404
    throw err
  }
  await pool.query(
    `INSERT INTO room_type_rate_plans (hotel_id, room_type_id, rate_plan_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [hotelId, roomTypeId, ratePlanId]
  )
}

async function detachRatePlan(pool, hotelId, roomTypeId, ratePlanId) {
  await pool.query(
    `DELETE FROM room_type_rate_plans
     WHERE hotel_id = $1 AND room_type_id = $2 AND rate_plan_id = $3`,
    [hotelId, roomTypeId, ratePlanId]
  )
}

async function cancelRatePlanUse(pool, hotelId, ratePlanId, { scope, room_type_ids } = {}) {
  const plan = await pool.query(
    `SELECT id FROM rate_plans WHERE id = $1 AND hotel_id = $2`,
    [ratePlanId, hotelId]
  )
  if (!plan.rows[0]) {
    const err = new Error('ไม่พบเรทแพลน')
    err.status = 404
    throw err
  }
  if (scope === 'all') {
    const detached = await pool.query(
      `DELETE FROM room_type_rate_plans
       WHERE hotel_id = $1 AND rate_plan_id = $2
       RETURNING room_type_id`,
      [hotelId, ratePlanId]
    )
    await deleteRatePlan(pool, hotelId, ratePlanId)
    return { scope: 'all', detached: detached.rows.length, deleted: true }
  }
  const ids = Array.isArray(room_type_ids)
    ? [...new Set(room_type_ids.map((id) => String(id || '').trim()).filter(Boolean))]
    : []
  if (!ids.length) {
    const err = new Error('เลือกประเภทห้องที่จะยกเลิก')
    err.status = 400
    throw err
  }
  const detached = await pool.query(
    `DELETE FROM room_type_rate_plans
     WHERE hotel_id = $1 AND rate_plan_id = $2 AND room_type_id = ANY($3::uuid[])
     RETURNING room_type_id`,
    [hotelId, ratePlanId, ids]
  )
  return { scope: 'some', detached: detached.rows.length, deleted: false }
}

function datesForBulk(dateFrom, dateTo, weekdays) {
  const from = String(dateFrom || '').slice(0, 10)
  const to = String(dateTo || '').slice(0, 10)
  if (!from || !to || to < from) {
    const err = new Error('เลือกช่วงวันที่ให้ถูกต้อง')
    err.status = 400
    throw err
  }
  const span = stayDates(from, addDaysYmd(to, 1))
  if (span.length > MAX_BULK_DAYS) {
    const err = new Error('กำหนดล่วงหน้าได้สูงสุด 3 ปีต่อครั้ง')
    err.status = 400
    throw err
  }
  return filterDatesByWeekday(span, weekdays)
}

async function upsertAllotments(pool, hotelId, roomTypeId, dates, roomsToSell) {
  if (!dates.length) return { updated: 0 }
  if (roomsToSell === null || roomsToSell === '') {
    await pool.query(
      `DELETE FROM channel_allotments
       WHERE hotel_id = $1 AND room_type_id = $2 AND stay_date = ANY($3::date[])`,
      [hotelId, roomTypeId, dates]
    )
    return { updated: dates.length, cleared: true }
  }
  const n = Math.max(0, Math.min(9999, parseInt(roomsToSell, 10) || 0))
  const values = []
  const params = [hotelId, roomTypeId]
  dates.forEach((d, i) => {
    params.push(d)
    values.push(`($1, $2, $${params.length}::date, ${n}, NOW())`)
  })
  await pool.query(
    `INSERT INTO channel_allotments (hotel_id, room_type_id, stay_date, rooms_to_sell, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (hotel_id, room_type_id, stay_date)
     DO UPDATE SET rooms_to_sell = EXCLUDED.rooms_to_sell, updated_at = NOW()`,
    params
  )
  return { updated: dates.length, rooms_to_sell: n }
}

async function upsertRateColumn(pool, hotelId, roomTypeId, ratePlanId, dates, column, value) {
  if (column !== 'price' && column !== 'abf' && column !== 'display_price') {
    const err = new Error('คอลัมน์ราคาไม่ถูกต้อง')
    err.status = 400
    throw err
  }
  if (!dates.length) return { updated: 0 }
  if (value === null || value === '') {
    await pool.query(
      `UPDATE channel_rates SET ${column} = NULL, updated_at = NOW()
       WHERE hotel_id = $1 AND room_type_id = $2 AND rate_plan_id = $3 AND stay_date = ANY($4::date[])`,
      [hotelId, roomTypeId, ratePlanId, dates]
    )
    await pool.query(
      `DELETE FROM channel_rates
       WHERE hotel_id = $1 AND room_type_id = $2 AND rate_plan_id = $3
         AND stay_date = ANY($4::date[])
         AND price IS NULL AND abf IS NULL AND display_price IS NULL`,
      [hotelId, roomTypeId, ratePlanId, dates]
    )
    return { updated: dates.length, cleared: true, column }
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('ราคาต้องเป็นตัวเลขไม่ติดลบ')
    err.status = 400
    throw err
  }
  const values = []
  const params = [hotelId, roomTypeId, ratePlanId]
  dates.forEach((d) => {
    params.push(d)
    if (column === 'price') {
      values.push(`($1, $2, $3, $${params.length}::date, ${n}, NULL, NULL, NOW())`)
    } else if (column === 'abf') {
      values.push(`($1, $2, $3, $${params.length}::date, NULL, ${n}, NULL, NOW())`)
    } else {
      values.push(`($1, $2, $3, $${params.length}::date, NULL, NULL, ${n}, NOW())`)
    }
  })
  const setCol = column === 'price'
    ? 'price = EXCLUDED.price'
    : column === 'abf'
      ? 'abf = EXCLUDED.abf'
      : 'display_price = EXCLUDED.display_price'
  await pool.query(
    `INSERT INTO channel_rates (hotel_id, room_type_id, rate_plan_id, stay_date, price, abf, display_price, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (hotel_id, room_type_id, rate_plan_id, stay_date)
     DO UPDATE SET ${setCol}, updated_at = NOW()`,
    params
  )
  return { updated: dates.length, column, value: n }
}

function discountFromPrices(sell, display) {
  const s = Number(sell)
  const d = Number(display)
  if (!Number.isFinite(s) || !Number.isFinite(d) || d <= s || s < 0 || d <= 0) return null
  const pct = Math.round((1 - s / d) * 100)
  if (pct < 1) return null
  return { display_price: d, discount_percent: pct }
}

function displayPriceFromPercent(sell, percent) {
  const s = Number(sell)
  const p = Number(percent)
  if (!Number.isFinite(s) || s < 0) return null
  if (!Number.isFinite(p) || p <= 0 || p >= 100) return null
  return Math.round(s / (1 - p / 100))
}

async function applyDisplayPrice(pool, hotelId, {
  mode,
  room_type_id,
  rate_plan_id,
  date_from,
  date_to,
  weekdays,
  input_mode = 'percent',
  value,
  action = 'set',
}) {
  const dates = datesForBulk(date_from, date_to, weekdays)
  const pairs = await resolveStopSalePairs(pool, hotelId, mode, room_type_id, rate_plan_id)
  const act = String(action || 'set').toLowerCase() === 'clear' ? 'clear' : 'set'

  if (act === 'clear') {
    let cleared = 0
    for (const pair of pairs) {
      const result = await upsertRateColumn(
        pool, hotelId, pair.room_type_id, pair.rate_plan_id, dates, 'display_price', null
      )
      cleared += result.updated || 0
    }
    return { action: 'clear', pairs: pairs.length, dates: dates.length, cleared }
  }

  const inputMode = String(input_mode || 'percent').toLowerCase() === 'amount' ? 'amount' : 'percent'
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') {
    const err = new Error(inputMode === 'amount' ? 'กรอกราคาแสดง' : 'กรอกเปอร์เซ็นต์ส่วนลด')
    err.status = 400
    throw err
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('ค่าต้องเป็นตัวเลขไม่ติดลบ')
    err.status = 400
    throw err
  }
  if (inputMode === 'percent' && (n <= 0 || n >= 100)) {
    const err = new Error('เปอร์เซ็นต์ส่วนลดต้องอยู่ระหว่าง 1–99')
    err.status = 400
    throw err
  }
  if (inputMode === 'amount' && n <= 0) {
    const err = new Error('ราคาแสดงต้องมากกว่า 0')
    err.status = 400
    throw err
  }

  let updated = 0
  let skipped = 0
  for (const pair of pairs) {
    if (!dates.length) continue
    if (inputMode === 'amount') {
      await upsertRateColumn(
        pool, hotelId, pair.room_type_id, pair.rate_plan_id, dates, 'display_price', n
      )
      updated += dates.length
      continue
    }
    const existing = await pool.query(
      `SELECT to_char(stay_date, 'YYYY-MM-DD') AS stay_date, price
       FROM channel_rates
       WHERE hotel_id = $1 AND room_type_id = $2 AND rate_plan_id = $3
         AND stay_date = ANY($4::date[]) AND price IS NOT NULL`,
      [hotelId, pair.room_type_id, pair.rate_plan_id, dates]
    )
    const byDate = Object.fromEntries(existing.rows.map((r) => [r.stay_date, Number(r.price)]))
    for (const d of dates) {
      const sell = byDate[d]
      if (sell == null || !Number.isFinite(sell)) {
        skipped += 1
        continue
      }
      const display = displayPriceFromPercent(sell, n)
      if (display == null || display <= sell) {
        skipped += 1
        continue
      }
      await upsertRateColumn(
        pool, hotelId, pair.room_type_id, pair.rate_plan_id, [d], 'display_price', display
      )
      updated += 1
    }
  }
  if (!updated && skipped) {
    const err = new Error('ยังไม่มีราคาขายในวันที่เลือก — ตั้งราคาขายก่อนแล้วค่อยใส่ %')
    err.status = 400
    throw err
  }
  return {
    action: 'set',
    input_mode: inputMode,
    value: n,
    pairs: pairs.length,
    dates: dates.length,
    updated,
    skipped,
  }
}

async function resolveStopSalePairs(pool, hotelId, mode, roomTypeId, ratePlanId) {
  const modeKey = String(mode || '').trim()
  if (modeKey === 'room_type') {
    if (!roomTypeId) {
      const err = new Error('เลือกประเภทห้อง')
      err.status = 400
      throw err
    }
    const links = await pool.query(
      `SELECT rate_plan_id FROM room_type_rate_plans
       WHERE hotel_id = $1 AND room_type_id = $2`,
      [hotelId, roomTypeId]
    )
    if (!links.rows.length) {
      const err = new Error('ประเภทห้องนี้ยังไม่มีเรทแพลน')
      err.status = 400
      throw err
    }
    return links.rows.map((r) => ({ room_type_id: roomTypeId, rate_plan_id: r.rate_plan_id }))
  }
  if (modeKey === 'rate_plan') {
    if (!ratePlanId) {
      const err = new Error('เลือกเรทแพลน')
      err.status = 400
      throw err
    }
    const links = await pool.query(
      `SELECT room_type_id FROM room_type_rate_plans
       WHERE hotel_id = $1 AND rate_plan_id = $2`,
      [hotelId, ratePlanId]
    )
    if (!links.rows.length) {
      const err = new Error('เรทแพลนนี้ยังไม่ได้ผูกกับประเภทห้อง')
      err.status = 400
      throw err
    }
    return links.rows.map((r) => ({ room_type_id: r.room_type_id, rate_plan_id: ratePlanId }))
  }
  if (modeKey === 'room_type_rate_plan') {
    if (!roomTypeId || !ratePlanId) {
      const err = new Error('เลือกประเภทห้องและเรทแพลน')
      err.status = 400
      throw err
    }
    const link = await pool.query(
      `SELECT 1 FROM room_type_rate_plans
       WHERE hotel_id = $1 AND room_type_id = $2 AND rate_plan_id = $3`,
      [hotelId, roomTypeId, ratePlanId]
    )
    if (!link.rows[0]) {
      const err = new Error('เรทแพลนนี้ไม่ได้ผูกกับประเภทห้องที่เลือก')
      err.status = 400
      throw err
    }
    return [{ room_type_id: roomTypeId, rate_plan_id: ratePlanId }]
  }
  const err = new Error('โหมดหยุดขายไม่ถูกต้อง')
  err.status = 400
  throw err
}

async function applyStopSale(pool, hotelId, {
  mode,
  room_type_id,
  rate_plan_id,
  date_from,
  date_to,
  weekdays,
  action = 'stop',
}) {
  const dates = datesForBulk(date_from, date_to, weekdays)
  const pairs = await resolveStopSalePairs(pool, hotelId, mode, room_type_id, rate_plan_id)
  const act = String(action || 'stop').toLowerCase() === 'open' ? 'open' : 'stop'

  if (act === 'open') {
    let cleared = 0
    for (const pair of pairs) {
      const result = await pool.query(
        `DELETE FROM channel_stop_sales
         WHERE hotel_id = $1 AND room_type_id = $2 AND rate_plan_id = $3
           AND stay_date = ANY($4::date[])`,
        [hotelId, pair.room_type_id, pair.rate_plan_id, dates]
      )
      cleared += result.rowCount || 0
    }
    return { action: 'open', pairs: pairs.length, dates: dates.length, cleared }
  }

  let updated = 0
  for (const pair of pairs) {
    if (!dates.length) continue
    const values = []
    const params = [hotelId, pair.room_type_id, pair.rate_plan_id]
    dates.forEach((d) => {
      params.push(d)
      values.push(`($1, $2, $3, $${params.length}::date, NOW())`)
    })
    await pool.query(
      `INSERT INTO channel_stop_sales (hotel_id, room_type_id, rate_plan_id, stay_date, updated_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (hotel_id, room_type_id, rate_plan_id, stay_date)
       DO UPDATE SET updated_at = NOW()`,
      params
    )
    updated += dates.length
  }
  return { action: 'stop', pairs: pairs.length, dates: dates.length, updated }
}

async function upsertRates(pool, hotelId, roomTypeId, ratePlanId, dates, price) {
  return upsertRateColumn(pool, hotelId, roomTypeId, ratePlanId, dates, 'price', price)
}

async function ensureTypeByName(pool, hotelId, name) {
  const result = await pool.query(
    `INSERT INTO room_types (hotel_id, name, price_per_night)
     VALUES ($1, $2, 0)
     ON CONFLICT (hotel_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [hotelId, name]
  )
  return result.rows[0]
}

async function getCalendar(pool, hotelId, { from, to, days }) {
  const start = String(from || '').slice(0, 10)
  if (!start) {
    const err = new Error('เลือกวันเริ่มต้น')
    err.status = 400
    throw err
  }
  const endInput = String(to || '').slice(0, 10)
  let windowDays
  if (endInput) {
    if (endInput < start) {
      const err = new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม')
      err.status = 400
      throw err
    }
    windowDays = daysInclusive(start, endInput)
  } else {
    windowDays = Number(days)
    if (!Number.isFinite(windowDays) || windowDays < 1) windowDays = 14
  }
  if (windowDays < 1 || windowDays > MAX_CALENDAR_DAYS) {
    const err = new Error(`ช่วงปฏิทินไม่เกิน ${MAX_CALENDAR_DAYS} วัน`)
    err.status = 400
    throw err
  }
  const dates = listDatesInclusive(start, windowDays)
  const end = dates[dates.length - 1]

  const settings = await getHotelSettings(pool, hotelId, [
    'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id', 'kiosk_com_no',
  ])
  const pmsOn = settings.kiosk_enabled === 'true'
    && Boolean(settings.kiosk_db_name && settings.kiosk_hotel_id && settings.kiosk_com_no)
  let vacantByType = {}
  try {
    if (pmsOn) {
      const { getKioskVacantByTypeDate } = require('./kioskVacantRooms')
      vacantByType = await getKioskVacantByTypeDate({
        dbName: settings.kiosk_db_name,
        hotelID: settings.kiosk_hotel_id,
        comNo: settings.kiosk_com_no,
        startDate: start,
        endDate: end,
      })
    } else {
      vacantByType = await getLocalVacantByTypeDate(pool, hotelId, dates)
    }
  } catch (err) {
    console.warn('[channel] vacant calendar failed:', err.message)
  }

  let pmsByCode = null
  if (pmsOn) {
    try {
      const { syncPmsRoomTypesToPg } = require('./kioskVacantRooms')
      pmsByCode = await syncPmsRoomTypesToPg(pool, hotelId, {
        dbName: settings.kiosk_db_name,
        hotelID: settings.kiosk_hotel_id,
      })
    } catch (err) {
      console.warn('[channel] PMS room-type sync skipped:', err.message)
    }
  }

  for (const typeName of Object.keys(vacantByType)) {
    await ensureTypeByName(pool, hotelId, typeName)
  }

  const types = await pool.query(
    `SELECT id, name FROM room_types WHERE hotel_id = $1 AND is_active = true ORDER BY sort_order ASC, name ASC`,
    [hotelId]
  )

  const typeIds = types.rows.map((r) => r.id)
  const allot = typeIds.length
    ? await pool.query(
      `SELECT room_type_id, to_char(stay_date, 'YYYY-MM-DD') AS stay_date, rooms_to_sell
       FROM channel_allotments
       WHERE hotel_id = $1 AND room_type_id = ANY($2) AND stay_date BETWEEN $3::date AND $4::date`,
      [hotelId, typeIds, start, end]
    )
    : { rows: [] }
  const links = typeIds.length
    ? await pool.query(
      `SELECT rtrp.room_type_id, rp.id, rp.name, rp.is_active, rp.includes_breakfast
       FROM room_type_rate_plans rtrp
       JOIN rate_plans rp ON rp.id = rtrp.rate_plan_id
       WHERE rtrp.hotel_id = $1 AND rtrp.room_type_id = ANY($2)
       ORDER BY lower(rp.name)`,
      [hotelId, typeIds]
    )
    : { rows: [] }
  const rates = typeIds.length
    ? await pool.query(
      `SELECT room_type_id, rate_plan_id, to_char(stay_date, 'YYYY-MM-DD') AS stay_date, price, abf, display_price
       FROM channel_rates
       WHERE hotel_id = $1 AND room_type_id = ANY($2) AND stay_date BETWEEN $3::date AND $4::date`,
      [hotelId, typeIds, start, end]
    )
    : { rows: [] }
  const stops = typeIds.length
    ? await pool.query(
      `SELECT room_type_id, rate_plan_id, to_char(stay_date, 'YYYY-MM-DD') AS stay_date
       FROM channel_stop_sales
       WHERE hotel_id = $1 AND room_type_id = ANY($2) AND stay_date BETWEEN $3::date AND $4::date`,
      [hotelId, typeIds, start, end]
    )
    : { rows: [] }

  const allotMap = {}
  for (const row of allot.rows) {
    if (!allotMap[row.room_type_id]) allotMap[row.room_type_id] = {}
    allotMap[row.room_type_id][row.stay_date] = Number(row.rooms_to_sell)
  }
  const rateMap = {}
  const abfMap = {}
  const displayMap = {}
  const stopMap = {}
  for (const row of rates.rows) {
    const key = `${row.room_type_id}:${row.rate_plan_id}`
    if (row.price != null) {
      if (!rateMap[key]) rateMap[key] = {}
      rateMap[key][row.stay_date] = Number(row.price)
    }
    if (row.abf != null) {
      if (!abfMap[key]) abfMap[key] = {}
      abfMap[key][row.stay_date] = Number(row.abf)
    }
    if (row.display_price != null) {
      if (!displayMap[key]) displayMap[key] = {}
      displayMap[key][row.stay_date] = Number(row.display_price)
    }
  }
  for (const row of stops.rows) {
    const key = `${row.room_type_id}:${row.rate_plan_id}`
    if (!stopMap[key]) stopMap[key] = {}
    stopMap[key][row.stay_date] = true
  }
  const plansByType = {}
  for (const row of links.rows) {
    if (!plansByType[row.room_type_id]) plansByType[row.room_type_id] = []
    const key = `${row.room_type_id}:${row.id}`
    plansByType[row.room_type_id].push({
      id: row.id,
      name: row.name,
      is_active: row.is_active,
      includes_breakfast: row.includes_breakfast === true,
      prices: rateMap[key] || {},
      abf: abfMap[key] || {},
      display_prices: displayMap[key] || {},
      stop_sale: stopMap[key] || {},
    })
  }

  const { pmsTypeCodeKey } = require('./kioskVacantRooms')
  const pmsNames = new Set(
    Object.keys(vacantByType).map((name) => pmsTypeCodeKey(name)).filter(Boolean)
  )
  // เปิด PMS: โชว์เฉพาะ RmType ของโรงแรม — ไม่ดึงประเภทที่สร้างตอนปิด PMS แม้จะมีเรทแพลนค้าง
  const shown = pmsByCode && pmsByCode.size
    ? types.rows.filter((rt) => pmsByCode.has(pmsTypeCodeKey(rt.name)))
    : pmsOn && pmsNames.size
      ? types.rows.filter((rt) => pmsNames.has(pmsTypeCodeKey(rt.name)))
      : types.rows

  const room_types = shown.map((rt) => ({
    id: rt.id,
    name: rt.name,
    pms_vacant: vacantByType[rt.name] || {},
    allotment: allotMap[rt.id] || {},
    rate_plans: plansByType[rt.id] || [],
  }))

  return {
    from: start,
    to: end,
    days: windowDays,
    pms: pmsOn,
    dates,
    room_types,
    rate_plans: await listRatePlans(pool, hotelId),
  }
}

async function getStayAllotmentCap(pool, hotelId, roomTypeId, checkIn, checkOut) {
  const dates = stayDates(checkIn, checkOut)
  if (!dates.length) return null
  const result = await pool.query(
    `SELECT to_char(stay_date, 'YYYY-MM-DD') AS stay_date, rooms_to_sell
     FROM channel_allotments
     WHERE hotel_id = $1 AND room_type_id = $2 AND stay_date = ANY($3::date[])`,
    [hotelId, roomTypeId, dates]
  )
  if (!result.rows.length) return null
  const byDate = Object.fromEntries(result.rows.map((r) => [r.stay_date, Number(r.rooms_to_sell)]))
  let cap = Infinity
  for (const d of dates) {
    if (!Object.prototype.hasOwnProperty.call(byDate, d)) continue
    cap = Math.min(cap, byDate[d])
  }
  if (!Number.isFinite(cap)) return null
  return cap
}

async function getChannelQuotes(pool, hotelId, roomTypeId, checkIn, checkOut) {
  const dates = stayDates(checkIn, checkOut)
  if (!dates.length) {
    return { dates, nights: 0, room: null, breakfast: null, plans: [], channel_closed: false, linked_plans: 0 }
  }
  const plans = await pool.query(
    `SELECT rp.id, rp.name, rp.includes_breakfast
     FROM room_type_rate_plans rtrp
     JOIN rate_plans rp ON rp.id = rtrp.rate_plan_id
     WHERE rtrp.hotel_id = $1 AND rtrp.room_type_id = $2 AND rp.is_active = true
     ORDER BY lower(rp.name)`,
    [hotelId, roomTypeId]
  )
  if (!plans.rows.length) {
    return {
      dates,
      nights: dates.length,
      room: null,
      breakfast: null,
      plans: [],
      channel_closed: false,
      linked_plans: 0,
    }
  }
  const rates = await pool.query(
    `SELECT rate_plan_id, to_char(stay_date, 'YYYY-MM-DD') AS stay_date, price, abf, display_price
     FROM channel_rates
     WHERE hotel_id = $1 AND room_type_id = $2
       AND rate_plan_id = ANY($3) AND stay_date = ANY($4::date[])`,
    [hotelId, roomTypeId, plans.rows.map((p) => p.id), dates]
  )
  const stops = await pool.query(
    `SELECT rate_plan_id, to_char(stay_date, 'YYYY-MM-DD') AS stay_date
     FROM channel_stop_sales
     WHERE hotel_id = $1 AND room_type_id = $2
       AND rate_plan_id = ANY($3) AND stay_date = ANY($4::date[])`,
    [hotelId, roomTypeId, plans.rows.map((p) => p.id), dates]
  )
  const byPlan = {}
  for (const row of rates.rows) {
    if (!byPlan[row.rate_plan_id]) byPlan[row.rate_plan_id] = {}
    byPlan[row.rate_plan_id][row.stay_date] = {
      price: row.price == null ? null : Number(row.price),
      abf: row.abf == null ? null : Number(row.abf),
      display_price: row.display_price == null ? null : Number(row.display_price),
    }
  }
  const stopped = new Set(stops.rows.map((r) => `${r.rate_plan_id}:${r.stay_date}`))
  const nights = dates.length
  let room = null
  let breakfast = null
  const listed = []
  let stoppedPlanCount = 0
  for (const plan of plans.rows) {
    if (dates.some((d) => stopped.has(`${plan.id}:${d}`))) {
      stoppedPlanCount += 1
      continue
    }
    const nightly = byPlan[plan.id] || {}
    if (dates.some((d) => nightly[d]?.price == null)) continue
    const roomTotal = dates.reduce((sum, d) => sum + Number(nightly[d].price || 0), 0)
    const withBf = plan.includes_breakfast === true
    const abfUnitTotal = withBf
      ? dates.reduce((sum, d) => sum + Number(nightly[d].abf || 0), 0)
      : 0
    const hasFullDisplay = dates.every((d) => nightly[d]?.display_price != null)
    const displayTotal = hasFullDisplay
      ? dates.reduce((sum, d) => sum + Number(nightly[d].display_price || 0), 0)
      : null
    const displayAvg = hasFullDisplay && nights ? displayTotal / nights : null
    const roomAvg = roomTotal / nights
    const promo = hasFullDisplay ? discountFromPrices(roomAvg, displayAvg) : null
    const candidate = {
      id: plan.id,
      rate_plan_id: plan.id,
      name: plan.name,
      rate_plan_name: plan.name,
      includes_breakfast: withBf,
      room_total: roomTotal,
      roomAvg,
      price_per_night: roomAvg,
      display_price_per_night: promo ? promo.display_price : null,
      discount_percent: promo ? promo.discount_percent : null,
      abf_unit_total: abfUnitTotal,
      abfAvg: nights ? abfUnitTotal / nights : 0,
      abf_per_person_per_night: withBf && nights ? abfUnitTotal / nights : 0,
      nights,
    }
    listed.push(candidate)
    if (!room || roomTotal < room.room_total) room = candidate
    if (withBf) {
      if (!breakfast || (roomTotal + abfUnitTotal) < (breakfast.room_total + breakfast.abf_unit_total)) {
        breakfast = candidate
      }
    }
  }
  // ผูกเรทแพลนไว้แล้ว และทุกแพลนถูกหยุดขายในช่วงพัก → ไม่ fallback ไปราคาตั้งค่าห้อง/PMS
  const channel_closed = listed.length === 0 && stoppedPlanCount === plans.rows.length
  return {
    dates,
    nights,
    room,
    breakfast,
    plans: listed,
    channel_closed,
    linked_plans: plans.rows.length,
  }
}

function parseBreakfastChoice(rawInclude, rawCount, partySize) {
  const include = rawInclude === true || rawInclude === 'true' || rawInclude === 1 || rawInclude === '1'
  const party = Math.max(1, Number(partySize) || 1)
  if (!include) return { includeBreakfast: false, breakfastCount: 0 }
  let n = parseInt(rawCount, 10)
  if (!Number.isFinite(n) || n < 1) n = party
  if (n > party) n = party
  return { includeBreakfast: true, breakfastCount: n }
}

async function quoteChannelStay(pool, hotelId, roomTypeId, checkIn, checkOut, opts = {}) {
  const quotes = await getChannelQuotes(pool, hotelId, roomTypeId, checkIn, checkOut)
  const planId = opts.rate_plan_id || opts.ratePlanId || null
  const picked = planId
    ? (quotes.plans || []).find((p) => p.id === planId || p.rate_plan_id === planId)
    : null
  if (planId && !picked) return null
  const { includeBreakfast, breakfastCount } = parseBreakfastChoice(
    opts.includeBreakfast ?? opts.include_breakfast,
    opts.breakfastCount ?? opts.breakfast_count,
    opts.partySize,
  )
  if (picked) {
    const canBf = picked.includes_breakfast === true
    const count = canBf
      ? parseBreakfastChoice(true, opts.breakfastCount ?? opts.breakfast_count, opts.partySize).breakfastCount
      : 0
    const abfTotal = canBf ? picked.abf_unit_total * count : 0
    return {
      rate_plan_id: picked.id,
      rate_plan_name: picked.name,
      includes_breakfast: canBf,
      breakfast_count: count,
      room_total: picked.room_total,
      abf_total: abfTotal,
      total: picked.room_total + abfTotal,
      roomAvg: picked.roomAvg,
      abfAvg: canBf ? picked.abfAvg : 0,
      nights: picked.nights,
    }
  }
  if (includeBreakfast) {
    if (!quotes.breakfast) return null
    const roomQuote = quotes.room || quotes.breakfast
    const abfTotal = quotes.breakfast.abf_unit_total * breakfastCount
    return {
      rate_plan_id: quotes.breakfast.rate_plan_id,
      rate_plan_name: quotes.breakfast.rate_plan_name,
      includes_breakfast: true,
      breakfast_count: breakfastCount,
      room_total: roomQuote.room_total,
      abf_total: abfTotal,
      total: roomQuote.room_total + abfTotal,
      roomAvg: roomQuote.roomAvg,
      abfAvg: quotes.breakfast.abfAvg,
      nights: quotes.nights,
    }
  }
  if (!quotes.room) return null
  return {
    rate_plan_id: quotes.room.rate_plan_id,
    rate_plan_name: quotes.room.rate_plan_name,
    includes_breakfast: false,
    breakfast_count: 0,
    room_total: quotes.room.room_total,
    abf_total: 0,
    total: quotes.room.room_total,
    roomAvg: quotes.room.roomAvg,
    abfAvg: 0,
    nights: quotes.nights,
  }
}

async function applyChannelToTypes(pool, hotelId, types, checkIn, checkOut) {
  if (!types?.length) return types
  for (const type of types) {
    const quotes = await getChannelQuotes(pool, hotelId, type.id, checkIn, checkOut)
    // ราคาขาย (channel) เป็นแหล่งเดียว — ไม่มีเรทแพลนครบราคา / หยุดขายครบ = ไม่ขาย
    if (quotes.channel_closed || !(quotes.plans || []).length || !quotes.room) {
      type.channel_closed = true
      type.rate_plans = []
      type.breakfast_available = false
      type.abf_per_night = 0
      type.abf_per_person_per_night = 0
      continue
    }
    type.channel_closed = false
    type.rate_plans = (quotes.plans || []).map((p) => ({
      id: p.id,
      name: p.name,
      includes_breakfast: p.includes_breakfast,
      price_per_night: p.price_per_night,
      display_price_per_night: p.display_price_per_night,
      discount_percent: p.discount_percent,
      abf_per_person_per_night: p.abf_per_person_per_night,
    }))
    type.price_per_night = quotes.room.roomAvg
    type.display_price_per_night = quotes.room.display_price_per_night || null
    type.discount_percent = quotes.room.discount_percent || null
    type.channel_rate_plan = quotes.room.rate_plan_name
    type.abf_per_night = 0
    type.breakfast_available = type.rate_plans.some((p) => p.includes_breakfast)
    type.abf_per_person_per_night = quotes.breakfast?.abfAvg || 0
  }
  return types.filter((t) => !t.channel_closed && (Number(t.available_count) || 0) > 0)
}

module.exports = {
  DAY_WINDOWS,
  MAX_CALENDAR_DAYS,
  addDaysYmd,
  stayDates,
  listDatesInclusive,
  daysInclusive,
  parseWeekdays,
  datesForBulk,
  assertPmsOn,
  listRatePlans,
  createRatePlan,
  updateRatePlan,
  deleteRatePlan,
  attachRatePlan,
  detachRatePlan,
  cancelRatePlanUse,
  upsertAllotments,
  upsertRates,
  upsertRateColumn,
  applyStopSale,
  applyDisplayPrice,
  getCalendar,
  getStayAllotmentCap,
  getChannelQuotes,
  parseBreakfastChoice,
  quoteChannelStay,
  applyChannelToTypes,
}
