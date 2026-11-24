const test = require('node:test')
const assert = require('node:assert/strict')
const { capPublicRooms, capSellRooms, publicSellableRooms, shouldAutoStopSale } = require('../src/utils/channelManager')

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

test('auto stop uses sell rooms when set, otherwise real vacant rooms', () => {
  assert.equal(shouldAutoStopSale(2, 6, 1), false)
  assert.equal(shouldAutoStopSale(2, 2, 10), true)
  assert.equal(shouldAutoStopSale(2, null, 2), true)
  assert.equal(shouldAutoStopSale(2, null, 3), false)
  assert.equal(shouldAutoStopSale(2, null, null), false)
  assert.equal(shouldAutoStopSale(null, null, 0), false)
})

test('stop minimum is held back before the display cap', () => {
  assert.equal(publicSellableRooms(6, 2, 3), 3)
  assert.equal(publicSellableRooms(3, 2, 3), 1)
  assert.equal(publicSellableRooms(2, 2, 3), 0)
  assert.equal(publicSellableRooms(6, 2, null), 4)
  assert.equal(publicSellableRooms(5, null, 3), 3)
  assert.equal(publicSellableRooms(1, 2, null), 0)
})

test('rooms for sale cannot exceed that day vacant count', () => {
  assert.equal(capSellRooms(6, 12), 6)
  assert.equal(capSellRooms(6, 5), 5)
  assert.equal(capSellRooms(6, 2), 2)
  assert.equal(capSellRooms(6, 0), 0)
  assert.equal(capSellRooms(6, null), 0)
})
