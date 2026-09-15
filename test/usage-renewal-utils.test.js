const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parsePrices,
  parseOptions,
  parseTier,
  tierIncludesLine,
  priceForTierMonths,
  normalizePromptPay,
} = require('../src/utils/usageRenewal')
const {
  parseUsageLimitDays,
  isShopUsageExpired,
  getUsageDaysRemaining,
  enrichShopUsage,
} = require('../src/utils/shopUsageLimit')

test('parsePrices reads month keys 1–12', () => {
  const prices = parsePrices(JSON.stringify({ '1': 149, '3': 399, '13': 999 }))
  assert.equal(prices['1'], 149)
  assert.equal(prices['3'], 399)
  assert.equal(prices['12'], 0)
})

test('parseOptions validates active renewal tiers', () => {
  const options = parseOptions([
    { id: 'a', label: '1 เดือน', months: 1, price: 149, active: true },
    { id: 'b', label: 'bad', months: 0, price: 100 },
    { id: 'c', label: '13 mo', months: 13, price: 100 },
  ])
  assert.equal(options.length, 1)
  assert.equal(options[0].months, 1)
})

test('parseTier and line inclusion', () => {
  assert.equal(parseTier('with_line'), 'with_line')
  assert.equal(parseTier('no_line'), 'no_line')
  assert.equal(parseTier('invalid'), null)
  assert.equal(tierIncludesLine('with_line'), true)
  assert.equal(tierIncludesLine('no_line'), false)
})

test('priceForTierMonths uses monthly rate from settings', () => {
  const settings = {
    price_per_month_no_line: 149,
    price_per_month_with_line: 249,
  }
  assert.equal(priceForTierMonths(settings, 'no_line', 3), 447)
})

test('normalizePromptPay strips non-digits', () => {
  assert.equal(normalizePromptPay('081-234-5678'), '0812345678')
})

test('shop usage limit expiry', () => {
  const started = new Date()
  started.setDate(started.getDate() - 5)
  const shop = {
    slug: 'demo',
    usage_limit_days: 3,
    usage_started_at: started.toISOString(),
  }
  assert.equal(parseUsageLimitDays('10'), 10)
  assert.equal(parseUsageLimitDays('-1'), null)
  assert.equal(isShopUsageExpired(shop), true)
  assert.equal(isShopUsageExpired({ slug: 'default', usage_limit_days: 1 }), false)
  assert.equal(getUsageDaysRemaining(shop), 0)
})

test('enrichShopUsage adds computed fields', () => {
  const enriched = enrichShopUsage({
    slug: 'demo',
    usage_limit_days: 30,
    created_at: new Date().toISOString(),
  })
  assert.equal(enriched.usage_limit_days, 30)
  assert.ok(enriched.usage_expires_at)
})

test('renewal default qr instruction constant', () => {
  const { DEFAULT_QR_INSTRUCTION } = require('../src/utils/usageRenewal')
  assert.match(DEFAULT_QR_INSTRUCTION, /QR/)
  assert.match(DEFAULT_QR_INSTRUCTION, /สลิป/)
})
