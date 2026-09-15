const test = require('node:test')
const assert = require('node:assert/strict')
const { parseHotelSlug, hotelSlugFromRequest } = require('../src/utils/userHotelPoints')

test('parseHotelSlug accepts kebab slugs', () => {
  assert.equal(parseHotelSlug('Default'), 'default')
  assert.equal(parseHotelSlug('  hotel-bkk  '), 'hotel-bkk')
})

test('parseHotelSlug rejects invalid values', () => {
  assert.equal(parseHotelSlug(''), null)
  assert.equal(parseHotelSlug('Hotel BKK'), null)
  assert.equal(parseHotelSlug('../etc'), null)
})

test('hotelSlugFromRequest reads X-Hotel-Slug', () => {
  assert.equal(hotelSlugFromRequest({ headers: { 'x-hotel-slug': 'Branch-One' } }), 'branch-one')
  assert.equal(hotelSlugFromRequest({ headers: {}, query: { hotel: 'default' } }), 'default')
  assert.equal(hotelSlugFromRequest({ headers: {} }), null)
})
