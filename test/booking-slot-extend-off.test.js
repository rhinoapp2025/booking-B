const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeSlotInput, matchesDayWindowSlot } = require('../src/utils/bookingSlotTimes')

test('day-hour window slot can be shorter than booking slot hours', () => {
  const body = { start_hour: 19, start_minute: 0, end_hour: 20, end_minute: 30 }
  const slot = normalizeSlotInput(body, 2)
  const windows = [{ start_hour: 19, start_minute: 0, end_hour: 20, end_minute: 30 }]

  assert.ok(slot)
  assert.ok(matchesDayWindowSlot(slot, windows))
  assert.notEqual(slot.endHour, slot.startHour + 2)
})

test('normal slot still expects full slot length when extend is off', () => {
  const body = { start_hour: 19, start_minute: 0, end_hour: 21, end_minute: 0 }
  const slot = normalizeSlotInput(body, 2)

  assert.equal(slot.endHour, slot.startHour + 2)
})
