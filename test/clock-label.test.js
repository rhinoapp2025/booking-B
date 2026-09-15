const test = require('node:test')
const assert = require('node:assert/strict')
const { formatHmLabel } = require('../src/utils/clockLabel')

test('formatHmLabel keeps same-day times unchanged', () => {
  assert.equal(formatHmLabel(10, 0), '10:00')
  assert.equal(formatHmLabel(22, 30), '22:30')
  assert.equal(formatHmLabel(23, 0), '23:00')
})

test('formatHmLabel converts extended hours to next-day clock', () => {
  assert.equal(formatHmLabel(24, 0), '00:00 (วันถัดไป)')
  assert.equal(formatHmLabel(25, 0), '01:00 (วันถัดไป)')
  assert.equal(formatHmLabel(26, 0), '02:00 (วันถัดไป)')
})
