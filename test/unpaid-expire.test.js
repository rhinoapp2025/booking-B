const test = require('node:test')
const assert = require('node:assert/strict')
const {
  computeExpiresAt,
  isBookingExpired,
  DEFAULT_HOURS,
  MIN_HOURS,
  MAX_HOURS,
} = require('../src/utils/unpaidExpire')

test('computeExpiresAt adds expire hours to created_at', () => {
  const created = new Date('2026-01-01T10:00:00.000Z')
  const expires = computeExpiresAt(created, 24)
  assert.equal(expires.getTime(), created.getTime() + 24 * 60 * 60 * 1000)
})

test('computeExpiresAt returns null for invalid date', () => {
  assert.equal(computeExpiresAt('not-a-date', 24), null)
})

test('isBookingExpired returns false when disabled', () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  assert.equal(isBookingExpired(old, 24, false), false)
})

test('isBookingExpired detects past expiry', () => {
  const created = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  assert.equal(isBookingExpired(created, 24, true), true)
})

test('isBookingExpired returns false before expiry', () => {
  const created = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
  assert.equal(isBookingExpired(created, 24, true), false)
})

test('expire hour bounds constants', () => {
  assert.equal(DEFAULT_HOURS, 24)
  assert.equal(MIN_HOURS, 1)
  assert.equal(MAX_HOURS, 168)
})
