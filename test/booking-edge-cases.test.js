const test = require('node:test')
const assert = require('node:assert/strict')
const { validateBookingSlot } = require('../src/utils/bookingHours')
const { finalizeBookingSlotWithServices } = require('../src/utils/bookingServiceDuration')
const { hasOverlapWithBookings, buildDynamicBookableSlots } = require('../src/utils/dynamicBookingSlots')
const { createMockBookingDb } = require('./helpers/mockBookingDb')

const SHOP_ID = 1
const SLOT_HOURS = 2
const NORMAL_DATE = '2026-08-25'
const NORMAL_DATE_2 = '2026-08-26'
const CUSTOM_DATE = '2026-08-30'
const CUSTOM_DATE_2 = '2026-08-31'

const CUSTOM_WINDOWS = [
  { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 },
  { start_hour: 15, start_minute: 0, end_hour: 17, end_minute: 30 },
  { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 30 },
]

const USER_OPTIONS = {
  1: { duration_min: 60 },
  2: { duration_min: 90 },
  3: { duration_min: 150 },
  4: { duration_min: 45 },
  5: { duration_min: 15 },
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
  if (slotError) return { ok: false, error: slotError, phase: 'validate' }
  const finalized = await finalizeBookingSlotWithServices(
    client,
    SHOP_ID,
    date,
    body,
    optionIds,
    bookingId
  )
  if (finalized.error) return { ok: false, error: finalized.error, phase: 'finalize' }

  const bookings = client.state.bookings.filter(
    (b) =>
      b.shop_id === SHOP_ID
      && String(b.booking_date).slice(0, 10) === String(date).slice(0, 10)
      && b.status !== 'cancelled'
  )
  const overlap = hasOverlapWithBookings(finalized.slot, bookings, SLOT_HOURS, bookingId)
  if (overlap) {
    return { ok: false, error: 'เวลานี้ทับกับคิวอื่น กรุณาเลือกเวลาใหม่', phase: 'overlap', slot: finalized.slot }
  }
  return { ok: true, slot: finalized.slot, phase: 'ok' }
}

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
  return { ok: true, slot: finalized.slot }
}

// ─── Edge 1: snap end แล้วทับคิวถัดไป ─────────────────────────────────────

test('edge: ปิดขyาย + snap end ยาวขึ้น → ทับคิวถัดไป (overlap)', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 201,
        shop_id: SHOP_ID,
        booking_date: NORMAL_DATE,
        start_hour: 11,
        start_minute: 0,
        end_hour: 12,
        end_minute: 30,
        status: 'pending',
      },
      {
        id: 202,
        shop_id: SHOP_ID,
        booking_date: NORMAL_DATE,
        start_hour: 12,
        start_minute: 30,
        end_hour: 14,
        end_minute: 30,
        status: 'pending',
      },
    ],
  })

  const edit = await runEdit(
    client,
    201,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0, end_hour: 12, end_minute: 30 },
    [4, 2]
  )
  assert.equal(edit.ok, false, edit.error)
  assert.equal(edit.phase, 'overlap')
  assert.equal(edit.slot.endHour, 13, 'snap เป็น 11:00–13:00 ทับคิว 12:30')
})

test('edge: ปิดขyาย + snap end สั้นลง → ไม่ทับคิวถัดไป', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 203,
        shop_id: SHOP_ID,
        booking_date: NORMAL_DATE,
        start_hour: 11,
        start_minute: 0,
        end_hour: 13,
        end_minute: 30,
        status: 'pending',
      },
      {
        id: 204,
        shop_id: SHOP_ID,
        booking_date: NORMAL_DATE,
        start_hour: 13,
        start_minute: 30,
        end_hour: 15,
        end_minute: 30,
        status: 'pending',
      },
    ],
  })

  const edit = await runEdit(
    client,
    203,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 30 },
    [1]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.equal(edit.slot.endHour, 13)
  assert.equal(edit.slot.endMinute, 0)
})

// ─── Edge 2: เคส production (overlay + PVC + ถอด) ───────────────────────────

test('edge: วันเฉพาะ + ปิดขyาย + คิว 17:30–19:15 เอาบริการ 15 น. ออก → snap 19:30', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 301,
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
    301,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [4, 2]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.equal(edit.slot.endHour, 19)
  assert.equal(edit.slot.endMinute, 30)
})

test('edge: วันเฉพาะ + ปิดขyาย + snap 19:30 ไม่ทับคิวช่วงก่อนหน้า (15:00–17:30)', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 302,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 17,
        start_minute: 30,
        end_hour: 19,
        end_minute: 15,
        status: 'pending',
      },
      {
        id: 303,
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

  const edit = await runEdit(
    client,
    302,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [4, 2]
  )
  assert.equal(edit.ok, true, edit.error)
})

// ─── Edge 3: เปิดขyายกลับ + บริการยาวเกินช่วงวัน ────────────────────────────

test('edge: เปิดขyาย + บริการรวมเกินช่วงวัน → reject (ไม่เปิด past close)', async () => {
  const client = createMockBookingDb({
    settings: {
      extend_booking_by_services: 'true',
      extend_booking_past_close: 'false',
    },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 401,
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

  const edit = await runEdit(
    client,
    401,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [4, 2, 3]
  )
  assert.equal(edit.ok, false)
  assert.match(edit.error, /ยาวเกินเวลาเปิดรับ/)
})

test('edge: เปิดขyาย + past close → บริการยาวเกินช่วงวันผ่านได้', async () => {
  const client = createMockBookingDb({
    settings: {
      extend_booking_by_services: 'true',
      extend_booking_past_close: 'true',
    },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 402,
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

  const edit = await runEdit(
    client,
    402,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [4, 2, 3]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.ok(edit.slot.endM > 19 * 60 + 30 || edit.slot.endHour > 19)
})

// ─── Edge 4: ย้ายวัน start ไม่ตรงช่วงปลายทาง ───────────────────────────────

test('edge: ย้ายจากวันปกติ → วันเฉพาะ โดยไม่เปลี่ยนเวลา (11:00 ไม่มีในช่วงวัน) → reject', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 501,
        shop_id: SHOP_ID,
        booking_date: NORMAL_DATE,
        start_hour: 11,
        start_minute: 0,
        end_hour: 13,
        end_minute: 0,
        status: 'pending',
      },
    ],
  })

  const move = await runEdit(
    client,
    501,
    CUSTOM_DATE,
    { start_hour: 14, start_minute: 0 },
    [1]
  )
  assert.equal(move.ok, false)
  assert.match(move.error, /ไม่ตรงกับเวลาที่เปิดรับ/)
})

test('edge: ย้ายวันเฉพาะ → วันเฉพาะอื่น คง start เดิมที่ไม่มีช่วงวันนั้น → reject', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: {
      [CUSTOM_DATE]: CUSTOM_WINDOWS,
      [CUSTOM_DATE_2]: [{ start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 }],
    },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 502,
        shop_id: SHOP_ID,
        booking_date: CUSTOM_DATE,
        start_hour: 17,
        start_minute: 30,
        end_hour: 19,
        end_minute: 30,
        status: 'pending',
      },
    ],
  })

  const move = await runEdit(
    client,
    502,
    CUSTOM_DATE_2,
    { start_hour: 17, start_minute: 30 },
    [1]
  )
  assert.equal(move.ok, false)
  assert.match(move.error, /ไม่ตรงกับเวลาที่เปิดรับ/)
})

// ─── Edge 5: คิวเก่า end ขyาย ยัง block dynamic slot จนกว่าจะแก้ ─────────────

test('edge: คิวเก่า end ขyาย ยังครองช่อง dynamic แม้ปิดขyายแล้ว', () => {
  const bookings = [
    {
      id: 601,
      start_hour: 17,
      start_minute: 30,
      end_hour: 19,
      end_minute: 15,
      status: 'pending',
    },
  ]
  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows: CUSTOM_WINDOWS,
    openHour: 9,
    lastBookingHour: 18,
    excludeBookingId: null,
  })
  const has1730 = available.some((s) => s.startHour === 17 && s.startMinute === 30)
  assert.equal(has1730, false, '17:30 ยังถูกคิวเก่า block อยู่')
})

test('edge: หลัง snap คิวเก่า end กลับช่วงวัน → end ใน DB ตรง window', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'true' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
    bookings: [
      {
        id: 602,
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

  client.setSetting('extend_booking_by_services', 'false')
  const edit = await runEdit(
    client,
    602,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30 },
    [4]
  )
  assert.equal(edit.ok, true, edit.error)
  assert.equal(edit.slot.endHour, 19)
  assert.equal(edit.slot.endMinute, 30)

  client.updateBooking(602, {
    end_hour: edit.slot.endHour,
    end_minute: edit.slot.endMinute,
  })

  const row = client.state.bookings.find((b) => b.id === 602)
  assert.equal(row.end_hour, 19)
  assert.equal(row.end_minute, 30, 'snap แล้ว end ใน DB ตรงช่วงวัน')
})

// ─── Edge 6: จองใหม่ส่ง end ผิด (ปิดขyาย) → backend resolve จาก start ────────

test('edge: จองใหม่ส่ง end เก่าแบบขyาย แต่ปิดขyาย → resolve จาก start', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    dayHours: { [CUSTOM_DATE]: CUSTOM_WINDOWS },
    options: USER_OPTIONS,
  })

  const book = await runBook(
    client,
    CUSTOM_DATE,
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 15 },
    [4, 2]
  )
  assert.equal(book.ok, true, book.error)
  assert.equal(book.slot.endHour, 19)
  assert.equal(book.slot.endMinute, 30)
})

test('edge: เวลาปกติ + ปิดขyาย + body ส่ง end ผิด → resolve 2 ชม.', async () => {
  const client = createMockBookingDb({
    settings: { extend_booking_by_services: 'false' },
    options: USER_OPTIONS,
  })

  const book = await runBook(
    client,
    NORMAL_DATE,
    { start_hour: 11, start_minute: 0, end_hour: 12, end_minute: 45 },
    [4, 5]
  )
  assert.equal(book.ok, true, book.error)
  assert.equal(book.slot.endHour, 13)
  assert.equal(book.slot.endMinute, 0)
})
