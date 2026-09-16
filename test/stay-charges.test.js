const test = require('node:test')
const assert = require('node:assert/strict')
const { applyStayCharges, sanitizePercentSetting } = require('../src/utils/stayCharges')

test('deposit mode does not add service charge or VAT', () => {
  const out = applyStayCharges(1000, {
    collectFull: false,
    serviceChargePercent: 10,
    vatPercent: 7,
  })
  assert.equal(out.total, 1000)
  assert.equal(out.service_charge, 0)
  assert.equal(out.vat, 0)
})

test('full payment adds service charge then VAT on the combined amount', () => {
  const out = applyStayCharges(1000, {
    collectFull: true,
    serviceChargePercent: 10,
    vatPercent: 7,
  })
  assert.equal(out.service_charge, 100)
  assert.equal(out.vat, 77)
  assert.equal(out.total, 1177)
})

test('full payment keeps satang and does not ceil to whole baht', () => {
  const out = applyStayCharges(999, {
    collectFull: true,
    serviceChargePercent: 10,
    vatPercent: 7,
  })
  assert.equal(out.service_charge, 99.9)
  assert.equal(out.vat, 76.92)
  assert.equal(out.total, 1175.82)
})

test('sanitizePercentSetting clamps to 0–100', () => {
  assert.equal(sanitizePercentSetting('10'), '10')
  assert.equal(sanitizePercentSetting('150'), '100')
  assert.equal(sanitizePercentSetting('-1'), '0')
  assert.equal(sanitizePercentSetting(''), '0')
})
