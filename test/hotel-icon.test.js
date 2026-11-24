const test = require('node:test')
const assert = require('node:assert/strict')
const { logoIconVersion, parseIconSize, hotelIconPublicUrl } = require('../src/utils/hotelIcon')

test('logoIconVersion uses the uploaded filename', () => {
  assert.equal(logoIconVersion('logo.1795531228223.jpg'), 'logo.1795531228223')
})

test('logoIconVersion is empty when there is no logo', () => {
  assert.equal(logoIconVersion(''), '0')
  assert.equal(logoIconVersion(null), '0')
})

test('parseIconSize accepts the nail icon sizes', () => {
  assert.equal(parseIconSize('32'), 32)
  assert.equal(parseIconSize('180'), 180)
  assert.equal(parseIconSize('192'), 192)
  assert.equal(parseIconSize('512'), 512)
  assert.equal(parseIconSize('64'), null)
})

test('hotelIconPublicUrl points at the branch icon', () => {
  assert.equal(
    hotelIconPublicUrl('https://theotel.app', 'sogoodhotel', 32, 'logo.1795531228223'),
    'https://theotel.app/api/hotels/sogoodhotel/icon/32.png?v=logo.1795531228223',
  )
})
