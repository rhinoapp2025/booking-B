const test = require('node:test')
const assert = require('node:assert/strict')
const {
  addDaysToYmd,
  computeBookUntilDate,
  validateBookingDateRange,
} = require('../src/utils/bookingWindow')

test('addDaysToYmd shifts calendar days', () => {
  assert.equal(addDaysToYmd('2026-01-30', 1), '2026-01-31')
  assert.equal(addDaysToYmd('2026-02-28', 1), '2026-03-01')
})

test('computeBookUntilDate uses advance days inclusive', () => {
  assert.equal(computeBookUntilDate(30, '2026-05-01'), '2026-05-30')
  assert.equal(computeBookUntilDate(1, '2026-05-01'), '2026-05-01')
})

test('validateBookingDateRange rejects invalid format', () => {
  assert.match(validateBookingDateRange('01-05-2026', '2026-12-31', '2026-05-01'), /รูปแบบ/)
})

test('validateBookingDateRange rejects past dates', () => {
  assert.match(
    validateBookingDateRange('2020-01-01', '2026-12-31', '2026-05-01'),
    /ผ่านมา/
  )
})

test('validateBookingDateRange rejects beyond book until', () => {
  assert.match(
    validateBookingDateRange('2026-06-01', '2026-05-31', '2026-05-01'),
    /จองได้ถึง/
  )
})

test('validateBookingDateRange accepts in-range date', () => {
  assert.equal(validateBookingDateRange('2026-05-15', '2026-05-31', '2026-05-01'), null)
})
