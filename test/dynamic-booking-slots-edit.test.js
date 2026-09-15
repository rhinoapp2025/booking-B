const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildDynamicBookableSlots,
  matchesDynamicSlotStart,
} = require('../src/utils/dynamicBookingSlots')

test('admin edit validation matches customer slots (no excludeBookingId on occupied time)', () => {
  const bookings = [
    {
      id: 5,
      start_hour: 17,
      start_minute: 30,
      end_hour: 19,
      end_minute: 30,
      status: 'pending',
    },
  ]
  const dayWindows = [{ start_hour: 10, start_minute: 0, end_hour: 20, end_minute: 30 }]
  const targetStart = { startHour: 18, startMinute: 0, startM: 18 * 60 }

  const available = buildDynamicBookableSlots({
    slotHours: 2,
    bookings,
    blocks: [],
    dayWindows,
    openHour: 10,
    lastBookingHour: 18,
  })
  assert.equal(matchesDynamicSlotStart(targetStart, available), false)
})
