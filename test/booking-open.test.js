const test = require('node:test')
const assert = require('node:assert/strict')
const { isBookingOpenValue, coerceBookingOpen } = require('../src/utils/bookingOpen')

test('missing booking_open means the branch accepts bookings', () => {
  assert.equal(isBookingOpenValue(undefined), true)
  assert.equal(isBookingOpenValue(null), true)
  assert.equal(isBookingOpenValue(''), true)
  assert.equal(isBookingOpenValue('1'), true)
})

test('booking_open off values close the branch', () => {
  assert.equal(isBookingOpenValue('0'), false)
  assert.equal(isBookingOpenValue('false'), false)
  assert.equal(isBookingOpenValue('off'), false)
})

test('coerceBookingOpen only treats explicit on values as open', () => {
  assert.equal(coerceBookingOpen(true), true)
  assert.equal(coerceBookingOpen('1'), true)
  assert.equal(coerceBookingOpen(false), false)
  assert.equal(coerceBookingOpen('0'), false)
  assert.equal(coerceBookingOpen(undefined), false)
})
