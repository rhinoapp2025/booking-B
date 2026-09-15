const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeAdminPhone, shapeHotelAdmin } = require('../src/utils/hotelAdmins')

test('normalizeAdminPhone keeps digits and plus', () => {
  assert.equal(normalizeAdminPhone('081-234-5678'), '0812345678')
  assert.equal(normalizeAdminPhone('+66 81 234 5678'), '+66812345678')
  assert.equal(normalizeAdminPhone('  089 111 2222  '), '0891112222')
})

test('normalizeAdminPhone empty on missing', () => {
  assert.equal(normalizeAdminPhone(''), '')
  assert.equal(normalizeAdminPhone(null), '')
})

test('shapeHotelAdmin uses login_id when present', () => {
  const row = shapeHotelAdmin({
    id: 'u1',
    name: 'สมชาย',
    provider: 'phone',
    provider_id: '0812345678',
    login_id: 'admin01',
    is_super_admin: false,
    created_at: '2026-01-01',
  })
  assert.equal(row.login, 'admin01')
  assert.equal(row.is_super_admin, false)
})

test('shapeHotelAdmin falls back to provider_id', () => {
  const row = shapeHotelAdmin({
    id: 'u1',
    name: 'สมชาย',
    provider: 'phone',
    provider_id: '0812345678',
    is_super_admin: false,
    created_at: '2026-01-01',
  })
  assert.equal(row.login, '0812345678')
})
