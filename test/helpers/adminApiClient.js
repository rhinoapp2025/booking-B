const BASE = process.env.SMOKE_BASE_URL || process.env.TEST_API_BASE_URL || 'http://localhost:3000'

function todayParts() {
  const today = new Date()
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return { ymd, ym: ymd.slice(0, 7) }
}

function buildAdminGetTests(ymd, ym) {
  return [
    { name: 'shops', path: '/api/admin/shops' },
    { name: 'users', path: '/api/admin/users' },
    { name: 'nailoptions', path: '/api/admin/nailoptions' },
    { name: 'service-categories', path: '/api/admin/service-categories' },
    { name: 'service-locations', path: '/api/admin/service-locations' },
    { name: 'showcase-clips', path: '/api/admin/showcase-clips' },
    { name: 'bookings', path: '/api/admin/bookings', params: { date: ymd } },
    { name: 'bookings-calendar', path: '/api/admin/bookings/calendar-summary', params: { month: ym } },
    { name: 'revenue', path: '/api/admin/revenue/summary', params: { month: ym } },
    { name: 'blocks', path: '/api/admin/blocks', params: { month: ym } },
    { name: 'extra-hours', path: '/api/admin/extra-hours', params: { month: ym } },
    { name: 'day-hours-month', path: '/api/admin/day-hours', params: { month: ym } },
    { name: 'day-hours-date', path: `/api/admin/day-hours/${ymd}` },
    { name: 'settings-deposit', path: '/api/admin/settings/deposit' },
    { name: 'settings-coupon', path: '/api/admin/settings/coupon' },
    { name: 'settings-line-push', path: '/api/admin/settings/line-push' },
    { name: 'settings-chat-notify', path: '/api/admin/settings/chat-notify' },
    { name: 'settings-unpaid', path: '/api/admin/settings/unpaid-auto-cancel' },
    { name: 'settings-shop-hours', path: '/api/admin/settings/shop-hours' },
    { name: 'settings-advance', path: '/api/admin/settings/advance-days' },
    { name: 'settings-booking-display', path: '/api/admin/settings/booking-display' },
    { name: 'settings-slot-hours', path: '/api/admin/settings/booking-slot-hours' },
    { name: 'settings-extend', path: '/api/admin/settings/extend-booking-by-services' },
    { name: 'settings-ui', path: '/api/admin/settings/ui' },
    { name: 'settings-register-pin', path: '/api/admin/settings/register-pin' },
    { name: 'settings-slip-retention', path: '/api/admin/settings/booking-slip-retention' },
    { name: 'payment-slips', path: '/api/admin/bookings/payment-slips' },
    { name: 'usage-renewal-settings', path: '/api/admin/usage-renewal/settings' },
    { name: 'usage-renewal-submissions', path: '/api/admin/usage-renewal/submissions' },
    { name: 'chat-conversations', path: '/api/admin/chat/conversations' },
    { name: 'chat-unread', path: '/api/admin/chat/unread-count' },
    { name: 'chat-notifications', path: '/api/admin/chat/notifications' },
    { name: 'bookings-options', path: '/api/bookings/options', params: { date: ymd } },
    { name: 'bookings-shop-hours', path: '/api/bookings/shop-hours' },
    { name: 'bookings-unpaid-expire', path: '/api/bookings/unpaid-expire-setting' },
    { name: 'bookings-ui-settings', path: '/api/bookings/ui-settings' },
    { name: 'bookings-day', path: '/api/bookings', params: { date: ymd } },
  ]
}

async function adminRequest(token, shop, method, path, { params, body } = {}) {
  const url = new URL(path, BASE)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  url.searchParams.set('shop', shop)

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Shop-Slug': shop,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })

  let data = null
  const text = await res.text()
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, ok: res.ok, data }
}

async function checkBackendHealth() {
  const res = await fetch(`${BASE}/health`)
  if (!res.ok) {
    throw new Error(`Backend not reachable at ${BASE}/health (${res.status})`)
  }
}

module.exports = {
  BASE,
  todayParts,
  buildAdminGetTests,
  adminRequest,
  checkBackendHealth,
}
