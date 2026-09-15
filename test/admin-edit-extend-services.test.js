const test = require('node:test')
const assert = require('node:assert/strict')
const { applyServiceDurationToSlot } = require('../src/utils/bookingServiceDuration')
const { normalizeSlotInput, toMinutes, normalizeMinute } = require('../src/utils/bookingSlotTimes')
const { buildDynamicBookableSlots } = require('../src/utils/dynamicBookingSlots')

/** เคสจากผู้ใช้: วันที่ 30 มีช่วง 17:30–19:30, คิว 17:30–19:00, overlay ~90 นาที */
const USER_DAY_WINDOWS = [
  { start_hour: 13, start_minute: 0, end_hour: 15, end_minute: 0 },
  { start_hour: 15, start_minute: 0, end_hour: 17, end_minute: 30 },
  { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 30 },
]

const EXISTING_BOOKING = {
  id: 99,
  start_hour: 17,
  start_minute: 30,
  end_hour: 19,
  end_minute: 0,
  status: 'pending',
}

function endWithinDayWindows(endM, dayWindows) {
  const maxEnd = Math.max(
    ...dayWindows.map((w) => toMinutes(Number(w.end_hour), normalizeMinute(w.end_minute)))
  )
  return endM <= maxEnd
}

test('overlay 90 นาที จาก 17:30 → จบ 19:00', () => {
  const base = normalizeSlotInput(
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 0 },
    2
  )
  const slot = applyServiceDurationToSlot(base, 90, 2)
  assert.ok(slot)
  assert.equal(slot.endHour, 19)
  assert.equal(slot.endMinute, 0)
})

test('เพิ่มนาทีรวมเป็น 240 → 17:30–21:30 (ตามขยายเวลาตามบริการ)', () => {
  const base = normalizeSlotInput(
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 0 },
    2
  )
  const slot = applyServiceDurationToSlot(base, 240, 2)
  assert.ok(slot)
  assert.equal(slot.endHour, 21)
  assert.equal(slot.endMinute, 30)
})

test('240 นาที เกินช่วงวัน 19:30 → ต้องขยายช่วงวันหรือเปิดเกินเวลาปิด', () => {
  const base = normalizeSlotInput(
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 0 },
    2
  )
  const slot = applyServiceDurationToSlot(base, 240, 2)
  assert.ok(slot)
  assert.equal(endWithinDayWindows(slot.endM, USER_DAY_WINDOWS), false)
})

test('ลดบริการเหลือ 60 นาที แต่คิวเดิม 17:30–19:00 → ยังจบ 19:00 (ไม่สั้นกว่าช่วงเดิม)', () => {
  const base = normalizeSlotInput(
    { start_hour: 17, start_minute: 30, end_hour: 19, end_minute: 0 },
    2
  )
  const slot = applyServiceDurationToSlot(base, 60, 2)
  assert.ok(slot)
  assert.equal(slot.endM - slot.startM, 90)
  assert.equal(slot.endHour, 19)
  assert.equal(slot.endMinute, 0)
})

test('โหมดขยายเวลา: dropdown ย้ายเวลาไม่รวมช่วงที่คิวนี้ครอง (17:30–19:00)', () => {
  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings: [EXISTING_BOOKING],
    blocks: [],
    dayWindows: USER_DAY_WINDOWS,
    openHour: 9,
    lastBookingHour: 18,
    excludeBookingId: null,
  })
  const labels = available.map(
    (s) => `${s.startHour}:${String(s.startMinute).padStart(2, '0')}-${s.endHour}:${String(s.endMinute).padStart(2, '0')}`
  )
  assert.ok(labels.some((l) => l.startsWith('13:00')), `ควรมีช่องว่าง 13:00 ได้ ${labels.join(', ')}`)
  assert.ok(labels.some((l) => l.startsWith('15:00')), `ควรมีช่องว่าง 15:00 ได้ ${labels.join(', ')}`)
  assert.equal(
    available.some((s) => s.startHour === 17 && s.startMinute === 30),
    false,
    'ไม่ควรมี 17:30 เป็นช่องว่างเพราะมีคิวอยู่'
  )
  assert.equal(
    available.some((s) => s.startHour === 19 && s.startMinute === 0),
    false,
    'ไม่มีช่อง 19:00–21:30 ใน dropdown ถ้าช่วงวันจบ 19:30'
  )
})

test('แก้คิวเดิมคงเวลาเริ่ม 17:30: ต้อง exclude booking id ไม่งั้น start ไม่ผ่าน validation', () => {
  const withoutExclude = buildDynamicBookableSlots({
    slotHours: 2,
    bookings: [EXISTING_BOOKING],
    blocks: [],
    dayWindows: USER_DAY_WINDOWS,
    openHour: 9,
    lastBookingHour: 18,
    excludeBookingId: null,
  })
  const withExclude = buildDynamicBookableSlots({
    slotHours: 2,
    bookings: [EXISTING_BOOKING],
    blocks: [],
    dayWindows: USER_DAY_WINDOWS,
    openHour: 9,
    lastBookingHour: 18,
    excludeBookingId: EXISTING_BOOKING.id,
  })
  const targetStart = { startHour: 17, startMinute: 30, startM: 17 * 60 + 30 }
  const { matchesDynamicSlotStart } = require('../src/utils/dynamicBookingSlots')
  assert.equal(matchesDynamicSlotStart(targetStart, withoutExclude), false)
  assert.equal(matchesDynamicSlotStart(targetStart, withExclude), true)
})

test('จำลองแอดมินแก้บริการ: เปลี่ยน nailoption_ids แล้ว backend คำนวณ end ใหม่ (ไม่ส่ง end_hour)', () => {
  const startBody = { start_hour: 17, start_minute: 30 }
  const base = normalizeSlotInput({ ...startBody, end_hour: 19, end_minute: 0 }, 2)

  const afterAddMinutes = applyServiceDurationToSlot(base, 150, 2)
  assert.equal(afterAddMinutes.endHour, 20)
  assert.equal(afterAddMinutes.endMinute, 0)

  const afterRemoveMinutes = applyServiceDurationToSlot(base, 90, 2)
  assert.equal(afterRemoveMinutes.endHour, 19)
  assert.equal(afterRemoveMinutes.endMinute, 0)
})
