const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeBookingSlotHours,
  normalizeBookingDisplayMode,
  bookingEndHour,
  MIN_SLOT_HOURS,
  MAX_SLOT_HOURS,
} = require('../src/utils/bookingSlotHours')
const {
  isExtendByServicesEnabled,
  isExtendPastCloseEnabled,
} = require('../src/utils/extendBookingSettings')
const { normalizePin, isValidPin } = require('../src/utils/registerShopPin')

test('normalizeBookingSlotHours clamps to 1–4', () => {
  assert.equal(normalizeBookingSlotHours(0), 2)
  assert.equal(normalizeBookingSlotHours(3), 3)
  assert.equal(normalizeBookingSlotHours(99), 2)
  assert.equal(MIN_SLOT_HOURS, 1)
  assert.equal(MAX_SLOT_HOURS, 4)
})

test('normalizeBookingDisplayMode accepts normal only', () => {
  assert.equal(normalizeBookingDisplayMode('normal'), 'normal')
  assert.equal(normalizeBookingDisplayMode('slots_2h'), 'slots_2h')
  assert.equal(normalizeBookingDisplayMode('unknown'), 'slots_2h')
})

test('bookingEndHour adds slot hours', () => {
  assert.equal(bookingEndHour(10, 2), 12)
})

test('extend booking settings parse truthy strings', () => {
  assert.equal(isExtendByServicesEnabled({ extend_booking_by_services: 'true' }), true)
  assert.equal(isExtendByServicesEnabled({ extend_booking_by_services: 'false' }), false)
  assert.equal(isExtendPastCloseEnabled({ extend_booking_past_close: 'true' }), true)
})

test('register shop pin normalization', () => {
  assert.equal(normalizePin('12ab34'), '1234')
  assert.equal(isValidPin('1234'), true)
  assert.equal(isValidPin('123'), false)
  assert.equal(isValidPin('abcd'), false)
})
