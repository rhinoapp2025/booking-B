const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { pathToFileURL } = require('url')
const {
  buildDynamicBookableSlots,
  buildDynamicTimelineSlots,
  shouldUseDynamicCustomDaySlots,
  matchesDynamicSlotStart,
  hasOverlapWithBookings,
  MIN_GAP_SLOT_MINUTES,
} = require('../src/utils/dynamicBookingSlots')
const {
  normalizeSlotInput,
  matchesDayWindowSlot,
  matchesDayWindowStart,
  rangesOverlap,
} = require('../src/utils/bookingSlotTimes')
const {
  applyServiceDurationToSlot,
} = require('../src/utils/bookingServiceDuration')

const FE_SLOTS_PATH = pathToFileURL(
  path.resolve(__dirname, '../../Frontend/src/utils/bookingSlots.js')
).href

function slotKey(s) {
  return `${s.startHour}:${s.startMinute ?? 0}-${s.endHour}:${s.endMinute ?? 0}`
}

function slotKeys(slots) {
  return [...slots]
    .sort((a, b) => (a.startM ?? a.startHour * 60) - (b.startM ?? b.startHour * 60))
    .map(slotKey)
}

async function loadFrontendSlots() {
  return import(FE_SLOTS_PATH)
}

// ─── 1. Static shop hours (no custom day, extend off path uses fixed blocks) ───

test('scenario: static dynamic bounds pack 2h slots from open to last+slot', () => {
  const slots = buildDynamicBookableSlots({
    slotHours: 2,
    bookings: [],
    blocks: [],
    dayWindows: [],
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.deepEqual(
    slotKeys(slots),
    ['9:0-11:0', '11:0-13:0', '13:0-15:0', '15:0-17:0', '17:0-19:0', '19:0-20:0']
  )
})

test('scenario: static mode rejects non-2h slot length when extend off', () => {
  const body = { start_hour: 10, start_minute: 0, end_hour: 11, end_minute: 0 }
  const slot = normalizeSlotInput(body, 2)
  assert.equal(slot.endHour - slot.startHour, 1)
})

// ─── 2. Custom day windows (extend off) ───

test('scenario: custom day window exact match (19:00–21:30)', () => {
  const windows = [{ start_hour: 19, start_minute: 0, end_hour: 20, end_minute: 30 }]
  const body = { start_hour: 19, start_minute: 0, end_hour: 20, end_minute: 30 }
  const slot = normalizeSlotInput(body, 2)
  assert.ok(matchesDayWindowSlot(slot, windows))
})

test('scenario: custom day window start-only for extend static phase', () => {
  const windows = [{ start_hour: 19, start_minute: 0, end_hour: 21, end_minute: 30 }]
  const start = normalizeSlotInput({ start_hour: 19, start_minute: 0, end_hour: 21, end_minute: 30 }, 2)
  assert.ok(matchesDayWindowStart(start, windows))
  const wrong = normalizeSlotInput({ start_hour: 20, start_minute: 0, end_hour: 22, end_minute: 0 }, 2)
  assert.equal(matchesDayWindowStart(wrong, windows), false)
})

// ─── 3. Custom day + extend, no active bookings → static ───

test('scenario: custom day + extend + empty day → static (not dynamic)', () => {
  const dayWindows = [{ start_hour: 19, start_minute: 0, end_hour: 21, end_minute: 30 }]
  assert.equal(
    shouldUseDynamicCustomDaySlots({ dayWindows, extendByServices: true, bookings: [] }),
    false
  )
})

// ─── 4. Custom day + extend + has booking → dynamic ───

test('scenario: custom day + extend + booking → dynamic packs after occupied time', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 20, end_minute: 0 }]
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0, status: 'pending' },
  ]
  assert.equal(
    shouldUseDynamicCustomDaySlots({ dayWindows, extendByServices: true, bookings }),
    true
  )

  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.ok(available.some((s) => s.startM === 12 * 60))
  assert.equal(available.some((s) => s.startM === 10 * 60), false)
})

// ─── 5. Multiple windows — no gap packing ───

test('scenario: two windows — no slots in between gap', () => {
  const dayWindows = [
    { start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 },
    { start_hour: 14, start_minute: 0, end_hour: 16, end_minute: 0 },
  ]
  const slots = buildDynamicBookableSlots({
    slotHours: 2,
    bookings: [],
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.equal(slots.some((s) => s.startM >= 12 * 60 && s.startM < 14 * 60), false)
})

// ─── 6. Min gap rules ───

test('scenario: gap >= 1h but < slotHours offers tail slot', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 13, end_minute: 0 }]
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0, status: 'pending' },
  ]
  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
    minGapMinutes: MIN_GAP_SLOT_MINUTES,
  })
  const tail = available.find((s) => s.startM === 12 * 60)
  assert.ok(tail, 'should offer 12:00–13:00 tail')
  assert.equal(tail.endM, 13 * 60)
})

test('scenario: gap < 1h is skipped', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 13, end_minute: 30 }]
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 31, status: 'pending' },
  ]
  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
  })
  // 12:31–13:30 = 59 min (< 60) → no tail slot
  assert.equal(available.some((s) => s.startM === 12 * 60 + 31), false)
})

// ─── 7. Full-day block ───

test('scenario: full-day block → no bookable slots', () => {
  const slots = buildDynamicBookableSlots({
    slotHours: 2,
    bookings: [],
    blocks: [{ is_full_day: true }],
    dayWindows: [],
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.equal(slots.length, 0)
})

// ─── 8. Cancelled bookings free the slot ───

test('scenario: cancelled booking does not block dynamic slots', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 20, end_minute: 0 }]
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0, status: 'cancelled' },
  ]
  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.ok(available.some((s) => s.startM === 10 * 60))
})

// ─── 9. Extend by services duration ───

test('scenario: extend by services lengthens slot to service minutes', () => {
  const base = normalizeSlotInput({ start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 }, 2)
  const extended = applyServiceDurationToSlot(base, 180, 2)
  assert.ok(extended)
  assert.equal(extended.endM - extended.startM, 180)
  assert.equal(extended.endHour, 13)
})

test('scenario: extend uses at least offered slot length', () => {
  const base = normalizeSlotInput({ start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 }, 2)
  const extended = applyServiceDurationToSlot(base, 60, 2)
  assert.equal(extended.endM - extended.startM, 120)
})

// ─── 10. Overlap detection ───

test('scenario: adjacent slots do not overlap', () => {
  assert.equal(rangesOverlap(10 * 60, 12 * 60, 12 * 60, 14 * 60), false)
})

test('scenario: overlapping bookings detected with minute precision', () => {
  const slot = normalizeSlotInput({ start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 }, 2)
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 45, end_hour: 12, end_minute: 30, status: 'pending' },
  ]
  assert.equal(hasOverlapWithBookings(slot, bookings, null, 2), true)
})

// ─── 11. Dynamic start validation ───

test('scenario: dynamic start must match available slot exactly', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 20, end_minute: 0 }]
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0, status: 'pending' },
  ]
  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.equal(
    matchesDynamicSlotStart({ startHour: 12, startMinute: 0, startM: 12 * 60 }, available),
    true
  )
  assert.equal(
    matchesDynamicSlotStart({ startHour: 12, startMinute: 30, startM: 12 * 60 + 30 }, available),
    false
  )
})

// ─── 12. Dynamic timeline shows booked + available ───

test('scenario: dynamic timeline merges booked rows and available gaps', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 16, end_minute: 0 }]
  const bookings = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0, status: 'pending' },
  ]
  const { booked, available, all } = buildDynamicTimelineSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 9,
    lastBookingHour: 18,
  })
  assert.equal(booked.length, 1)
  assert.ok(available.some((s) => s.startM === 12 * 60))
  assert.equal(all.length, booked.length + available.length)
})

// ─── 13. FE/BE parity — same inputs produce same available slots ───

test('scenario: frontend and backend dynamic slots stay in sync', async () => {
  const fe = await loadFrontendSlots()
  const params = {
    slotHours: 2,
    bookings: [
      { id: 1, start_hour: 16, start_minute: 0, end_hour: 18, end_minute: 0, status: 'pending' },
    ],
    blocks: [],
    dayWindows: [{ start_hour: 10, start_minute: 0, end_hour: 20, end_minute: 30 }],
    openHour: 9,
    lastBookingHour: 18,
    excludeBookingId: null,
  }

  const beAvailable = buildDynamicBookableSlots(params)
  const feAvailable = fe.buildDynamicBookableSlots(params)

  assert.deepEqual(slotKeys(beAvailable), slotKeys(feAvailable))
})

test('scenario: frontend shouldUseDynamicCustomDaySlots matches backend', async () => {
  const fe = await loadFrontendSlots()
  const dayWindows = [{ start_hour: 19, start_minute: 0, end_hour: 21, end_minute: 30 }]
  const cases = [
    { extendByServices: true, bookings: [] },
    { extendByServices: true, bookings: [{ id: 1, status: 'pending' }] },
    { extendByServices: false, bookings: [{ id: 1, status: 'pending' }] },
  ]
  for (const c of cases) {
    assert.equal(
      fe.shouldUseDynamicCustomDaySlots({ dayWindows, ...c }),
      shouldUseDynamicCustomDaySlots({ dayWindows, ...c }),
      JSON.stringify(c)
    )
  }
})

test('scenario: frontend visible bookable slots match backend select slots', async () => {
  const fe = await loadFrontendSlots()
  const params = {
    openHour: 9,
    lastBookingHour: 18,
    extras: [],
    dayWindows: [
      { start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 },
      { start_hour: 14, start_minute: 0, end_hour: 16, end_minute: 0 },
    ],
    blocks: [],
    bookings: [
      { id: 2, start_hour: 14, start_minute: 0, end_hour: 16, end_minute: 0, status: 'pending' },
    ],
    displayMode: 'slots_2h',
    slotHours: 2,
    extendByServices: true,
    excludeBookingId: null,
  }

  const beSelect = buildDynamicBookableSlots({
    slotHours: params.slotHours,
    bookings: params.bookings,
    blocks: params.blocks,
    dayWindows: params.dayWindows,
    openHour: params.openHour,
    lastBookingHour: params.lastBookingHour,
  })
  const feSelect = fe.buildBookableSlotSelectSlots(params)

  assert.deepEqual(slotKeys(beSelect), slotKeys(feSelect))
})
