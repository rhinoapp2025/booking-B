const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildDynamicBookableSlots,
  shouldUseDynamicCustomDaySlots,
} = require('../src/utils/dynamicBookingSlots')

test('dynamic slots do not fill gaps between separate day windows', () => {
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

  assert.ok(slots.some((s) => s.startM === 10 * 60))
  assert.ok(slots.some((s) => s.startM === 14 * 60))
  assert.equal(
    slots.some((s) => s.startM >= 12 * 60 && s.startM < 14 * 60),
    false,
    'should not offer slots in the lunch gap'
  )
})

test('shouldUseDynamicCustomDaySlots requires active bookings when extend is on', () => {
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 20, end_minute: 0 }]

  assert.equal(
    shouldUseDynamicCustomDaySlots({ dayWindows, extendByServices: true, bookings: [] }),
    false
  )
  assert.equal(
    shouldUseDynamicCustomDaySlots({
      dayWindows,
      extendByServices: true,
      bookings: [{ id: 1, status: 'pending' }],
    }),
    true
  )
  assert.equal(
    shouldUseDynamicCustomDaySlots({
      dayWindows,
      extendByServices: true,
      bookings: [{ id: 1, status: 'cancelled' }],
    }),
    false
  )
})
