const test = require('node:test')
const assert = require('node:assert/strict')
const { validateBookingSlot } = require('../src/utils/bookingHours')
const { finalizeBookingSlotWithServices } = require('../src/utils/bookingServiceDuration')
const { hasOverlapWithBookings } = require('../src/utils/dynamicBookingSlots')
const { createMockBookingDb } = require('./helpers/mockBookingDb')

const SHOP_ID = 1
const SLOT_HOURS = 2
const NORMAL_DATE = '2026-08-25'
const NORMAL_DATE_2 = '2026-08-26'
const CUSTOM_DATE = '2026-08-30'

const CUSTOM_WINDOWS = [
  { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 },
  { start_hour: 15, start_minute: 0, end_hour: 17, end_minute: 30 },
  { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 30 },
]

async function runBook(client, date, body, optionIds) {
  const slotError = await validateBookingSlot(client, SHOP_ID, date, body, SLOT_HOURS, null)
  if (slotError) return { ok: false, error: slotError }
  const finalized = await finalizeBookingSlotWithServices(
    client,
    SHOP_ID,
    date,
    body,
    optionIds,
    null
  )
  if (finalized.error) return { ok: false, error: finalized.error }
  return { ok: true, slot: finalized.slot, totalServiceMinutes: finalized.totalServiceMinutes }
}

async function runEdit(client, bookingId, date, body, optionIds) {
  const slotError = await validateBookingSlot(
    client,
    SHOP_ID,
    date,
    body,
    SLOT_HOURS,
    bookingId
  )
  if (slotError) return { ok: false, error: slotError }
  const finalized = await finalizeBookingSlotWithServices(
    client,
    SHOP_ID,
    date,
    body,
    optionIds,
    bookingId
  )
  if (finalized.error) return { ok: false, error: finalized.error }

  const bookings = client.state.bookings.filter(
    (b) =>
      b.shop_id === SHOP_ID
      && String(b.booking_date).slice(0, 10) === String(date).slice(0, 10)
      && b.status !== 'cancelled'
  )
  const overlap = hasOverlapWithBookings(finalized.slot, bookings, SLOT_HOURS, bookingId)
  if (overlap) return { ok: false, error: 'เวลานี้ทับกับคิวอื่น กรุณาเลือกเวลาใหม่' }

  return { ok: true, slot: finalized.slot, totalServiceMinutes: finalized.totalServiceMinutes }
}

async function runMoveDate(client, bookingId, fromDate, toDate, body, optionIds) {
  return runEdit(client, bookingId, toDate, body, optionIds)
}

// ─── 1. เวลาปกติ ───────────────────────────────────────────────────────────

test('โหมด 1a: เวลาปกติ + ไม่ขยาย — จอง / แก้บริการ / ย้ายวัน', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
  })

  const book = await runBook(
    client,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 },
    [1]
  )
  assert.equal(book.ok, true, book.error)
  assert.equal(book.slot.endHour, 13)

  const booking = client.addBooking({
    booking_date: NORMAL_DATE,
    start_hour: 11,
    start_minute: 0,
    end_hour: 13,
    end_minute: 0,
  })

  const edit = await runEdit(
    client,
    booking.id,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 },
    [2, 3]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.equal(edit.slot.endHour, 13, 'ไม่ขยาย: เปลี่ยนบริการไม่เปลี่ยน end')

  const move = await runMoveDate(
    client,
    booking.id,
    NORMAL_DATE,
    NORMAL_DATE_2,
    { start_hour: 15, start_minute: 0, end_hour: 17, end_minute: 0 },
    [1]
  )
  assert.equal(move.ok, true, move.error)
  assert.equal(move.slot.startHour, 15)
  assert.equal(move.slot.endHour, 17)
})

test('โหมด 1b: เวลาปกติ + ขยายบริการ — จอง / แก้บริการ / ย้ายวัน', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
  })

  const book = await runBook(
    client,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0 },
    [2]
  )
  assert.equal(book.ok, true, book.error)
  assert.equal(book.slot.endHour, 13, '90 นาที แต่ขั้นต่ำ 2 ชม.')

  const booking = client.addBooking({
    booking_date: NORMAL_DATE,
    start_hour: 11,
    start_minute: 0,
    end_hour: 13,
    end_minute: 0,
  })

  const editMore = await runEdit(
    client,
    booking.id,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0 },
    [3]
  )
  assert.equal(editMore.ok, true, editMore.error)
  assert.equal(editMore.slot.endHour, 13, '150 นาที → 11:00–13:30')
  assert.equal(editMore.slot.endMinute, 30)

  const editSameStart = await runEdit(
    client,
    booking.id,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0 },
    [2]
  )
  assert.equal(editSameStart.ok, true, editSameStart.error)

  client.updateBooking(booking.id, {
    start_hour: 11,
    start_minute: 0,
    end_hour: 13,
    end_minute: 0,
  })

  const move = await runMoveDate(
    client,
    booking.id,
    NORMAL_DATE,
    NORMAL_DATE_2,
    { start_hour: 13, start_minute: 0 },
    [3]
  )
  assert.equal(move.ok, true, move.error)
  assert.equal(move.slot.startHour, 13)
  assert.equal(move.slot.endHour, 15)
  assert.equal(move.slot.endMinute, 30, '13:00 + 150 นาที')
})

// ─── 2. เวลาเฉพาะวัน ───────────────────────────────────────────────────────

test('โหมด 2a: เวลาเฉพาะวัน + ไม่ขยาย — แก้บริการคิวที่เคยขยายเวลา (end เก่าไม่ตรงช่วงวัน)', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    bookings: [
      {
        id: 101,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 17,
        start_minute: 30,
        end_hour: 19,
        end_minute: 15,
        status: 'pending',
      },
    ],
  })

  const edit = await runEdit(
    client,
    101,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 15 },
    [1, 2]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.equal(edit.slot.startHour, 17)
  assert.equal(edit.slot.startMinute, 30)
  assert.equal(edit.slot.endHour, 19)
  assert.equal(edit.slot.endMinute, 30, 'snap กลับช่วงวัน 17:30–19:30')
})

test('โหมด 2a: เวลาเฉพาะวัน + ไม่ขยาย — จอง / แก้บริการ / ย้ายไปวันปกติ', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
  })

  const book = await runBook(
    client,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 30 },
    [1]
  )
  assert.equal(book.ok, true, book.error)

  const badWindow = await runBook(
    client,
    CUSTOM_DATE,
    { start_hour: 12, start_minute: 0, end_hour: 14, end_minute: 0 },
    [1]
  )
  assert.equal(badWindow.ok, false)
  assert.match(badWindow.error, /ไม่ตรงกับเวลาที่เปิดรับ/)

  const booking = client.addBooking({
    booking_date: CUSTOM_DATE,
    start_hour: 17,
    start_minute: 30,
    end_hour: 19,
    end_minute: 30,
  })

  const edit = await runEdit(
    client,
    booking.id,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 30 },
    [2, 3]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.equal(edit.slot.endHour, 19)
  assert.equal(edit.slot.endMinute, 30, 'ไม่ขยาย: บริการไม่เปลี่ยนช่วง')

  const moveToNormal = await runMoveDate(
    client,
    booking.id,
    CUSTOM_DATE,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 },
    [1]
  )
  assert.equal(moveToNormal.ok, true, moveToNormal.error)
  assert.equal(moveToNormal.slot.endHour, 13)
})

test('โหมด 2b: เวลาเฉพาะวัน + ขยาย + ยังไม่มีคิว — จอง static start', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
  })

  const book = await runBook(
    client,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [2]
  )
  assert.equal(book.ok, true, book.error)
  assert.equal(book.slot.endHour, 19)
  assert.equal(book.slot.endMinute, 0, '90 นาที แต่ขั้นต่ำช่วงเดิม 17:30–19:00 ถ้ามี end ใน body')
})

test('โหมด 2c: เวลาเฉพาะวัน + ขยาย + มีคิว — แก้บริการคิวเดิม (exclude id)', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    bookings: [
      {
        id: 99,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 17,
        start_minute: 30,
        end_hour: 19,
        end_minute: 0,
        status: 'pending',
      },
    ],
  })

  const editKeepStart = await runEdit(
    client,
    99,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [2]
  )
  assert.equal(editKeepStart.ok, true, editKeepStart.error)
  assert.equal(editKeepStart.slot.endHour, 19)
  assert.equal(editKeepStart.slot.endMinute, 0, '90 นาที คง start 17:30 → 19:00')

  const editTooLong = await runEdit(
    client,
    99,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [2, 3]
  )
  assert.equal(editTooLong.ok, false)
  assert.match(editTooLong.error, /ยาวเกินเวลาเปิดรับ/)

  const editWithoutExclude = await validateBookingSlot(
    client,
    SHOP_ID,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    SLOT_HOURS,
    null
  )
  assert.ok(editWithoutExclude, 'จองใหม่ที่ 17:30 ต้องไม่ผ่านเพราะมีคิวอยู่')
})

test('โหมด 2d: เวลาเฉพาะวัน + ขยาย — ย้ายไปวันปกติ', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    bookings: [
      {
        id: 50,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 17,
        start_minute: 30,
        end_hour: 19,
        end_minute: 0,
        status: 'pending',
      },
    ],
  })

  const move = await runMoveDate(
    client,
    50,
    CUSTOM_DATE,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0 },
    [2]
  )
  assert.equal(move.ok, true, move.error)
  assert.equal(move.slot.startHour, 11)
  assert.equal(move.slot.endHour, 13)
})

// ─── 3. ย้ายจากวันเฉพาะ → วันปกติ (รวมทั้งสองโหมดขยาย) ───────────────────

test('โหมด 3: ย้ายวันเฉพาะ → ปกติ + ไม่ขยาย — ใช้กฎ 2 ชม. บนวันปลายทาง', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    bookings: [
      {
        id: 70,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 15,
        start_minute: 0,
        end_hour: 17,
        end_minute: 30,
        status: 'pending',
      },
    ],
  })

  const move = await runMoveDate(
    client,
    70,
    CUSTOM_DATE,
    NORMAL_DATE_2,
    { start_hour: 9, start_minute: 0, end_hour: 11, end_minute: 0 },
    [1]
  )
  assert.equal(move.ok, true, move.error)
  assert.equal(move.slot.endHour, 11)
})

test('โหมด 3: ย้ายวันเฉพาะ → ปกติ + ขยาย — dynamic บนวันปลายทาง', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    bookings: [
      {
        id: 80,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 11,
        start_minute: 0,
        end_hour: 13,
        end_minute: 0,
        status: 'pending',
      },
      {
        id: 81,
        shop_id: SHOP_ID,
        booking_date: NORMAL_DATE_2,
        start_hour: 11,
        start_minute: 0,
        end_hour: 13,
        end_minute: 0,
        status: 'pending',
      },
    ],
  })

  const moveBlocked = await runMoveDate(
    client,
    80,
    CUSTOM_DATE,
    NORMAL_DATE_2,
    { start_hour: 11, start_minute: 0 },
    [1]
  )
  assert.equal(moveBlocked.ok, false, '11:00 บนวันปลายทางมีคิวอื่นอยู่')

  const moveOk = await runMoveDate(
    client,
    80,
    CUSTOM_DATE,
    NORMAL_DATE_2,
    { start_hour: 13, start_minute: 0 },
    [3]
  )
  assert.equal(moveOk.ok, true, moveOk.error)
  assert.equal(moveOk.slot.endHour, 15)
  assert.equal(moveOk.slot.endMinute, 30, '13:00 + 150 นาที')
})

test('โหมด 3: ย้ายวันเฉพาะ → ปกติ + ขยาย — คงเวลาเดิมบนวันปลายทางด้วย exclude id', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    bookings: [
      {
        id: 90,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 17,
        start_minute: 30,
        end_hour: 19,
        end_minute: 0,
        status: 'pending',
      },
    ],
  })

  const move = await runMoveDate(
    client,
    90,
    CUSTOM_DATE,
    NORMAL_DATE,
    { start_hour: 15, start_minute: 0 },
    [2, 3]
  )
  assert.equal(move.ok, true, move.error)
  assert.equal(move.slot.startHour, 15)
  assert.equal(move.slot.endHour, 19, '240 นาที บนวันปกติ → 15:00–19:00')
  assert.equal(move.slot.endMinute, 0)
})
