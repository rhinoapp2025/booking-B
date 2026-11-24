const test = require('node:test')
const assert = require('node:assert/strict')
const { capPublicRooms } = require('../src/utils/channelManager')

test('no display cap keeps the real vacant count', () => {
  assert.equal(capPublicRooms(5, null), 5)
  assert.equal(capPublicRooms(5, undefined), 5)
})

test('display cap hides extra vacant rooms', () => {
  assert.equal(capPublicRooms(5, 3), 3)
})

test('display cap stays when sales bring real inventory down to the cap', () => {
  assert.equal(capPublicRooms(3, 3), 3)
})

test('real inventory below the display cap is what guests see', () => {
  assert.equal(capPublicRooms(2, 3), 2)
  assert.equal(capPublicRooms(0, 3), 0)
})
