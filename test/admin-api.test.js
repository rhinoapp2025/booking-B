const test = require('node:test')
const assert = require('node:assert/strict')

const { ensureTestAdmin } = require('./helpers/testAdmin')
const {
  adminRequest,
  buildAdminGetTests,
  checkBackendHealth,
  todayParts,
} = require('./helpers/adminApiClient')

test('admin API smoke tests', async (t) => {
  await checkBackendHealth()
  const { token, shop } = await ensureTestAdmin()
  const { ymd, ym } = todayParts()
  const getTests = buildAdminGetTests(ymd, ym)

  await t.test('GET endpoints respond successfully', async () => {
    const failures = []
    for (const item of getTests) {
      const res = await adminRequest(token, shop, 'GET', item.path, { params: item.params })
      if (!res.ok) {
        failures.push(`${item.name} [${res.status}] ${res.data?.error || JSON.stringify(res.data)}`)
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'))
  })

  await t.test('settings round-trip: deposit', async () => {
    const current = await adminRequest(token, shop, 'GET', '/api/admin/settings/deposit')
    assert.ok(current.ok, current.data?.error)
    const amount = Number(current.data?.deposit_amount ?? current.data?.amount ?? 300)
    const saved = await adminRequest(token, shop, 'PATCH', '/api/admin/settings/deposit', {
      body: { deposit_amount: amount },
    })
    assert.ok(saved.ok, saved.data?.error)
  })

  await t.test('settings round-trip: shop hours', async () => {
    const current = await adminRequest(token, shop, 'GET', '/api/admin/settings/shop-hours')
    assert.ok(current.ok, current.data?.error)
    const saved = await adminRequest(token, shop, 'PATCH', '/api/admin/settings/shop-hours', {
      body: {
        open_hour: current.data.open_hour,
        last_booking_hour: current.data.last_booking_hour,
      },
    })
    assert.ok(saved.ok, saved.data?.error)
  })

  await t.test('settings round-trip: advance days', async () => {
    const current = await adminRequest(token, shop, 'GET', '/api/admin/settings/advance-days')
    assert.ok(current.ok, current.data?.error)
    const saved = await adminRequest(token, shop, 'PATCH', '/api/admin/settings/advance-days', {
      body: { advance_days: current.data.advance_days ?? 30 },
    })
    assert.ok(saved.ok, saved.data?.error)
  })
})
