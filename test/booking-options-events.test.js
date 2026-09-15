const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeOptionIds } = require('../src/utils/bookingOptions')
const { emitBookingChanged, subscribeBookingEvents } = require('../src/utils/bookingEvents')

test('normalizeOptionIds deduplicates and stringifies', () => {
  assert.deepEqual(normalizeOptionIds(['1', '2', '1', '']), ['1', '2'])
  assert.deepEqual(normalizeOptionIds(null), [])
})

test('booking events emit and subscribe', () => {
  const shopId = `test-shop-${Date.now()}`
  const events = []
  const unsubscribe = subscribeBookingEvents(shopId, (payload) => {
    events.push(payload)
  })
  emitBookingChanged(shopId, {
    type: 'payment_confirmed',
    booking_id: 42,
    booking_date: '2026-05-01',
  })
  unsubscribe()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'payment_confirmed')
  assert.equal(events[0].booking_id, 42)
})
