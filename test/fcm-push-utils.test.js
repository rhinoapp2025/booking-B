const test = require('node:test')
const assert = require('node:assert/strict')
const { buildChatPushPayload } = require('../src/utils/fcmPush')

test('customer chat push opens customer chat thread', () => {
  const payload = buildChatPushPayload({
    shopSlug: 'demo',
    title: 'ข้อความใหม่ · Demo',
    body: 'สวัสดี',
    target: 'customer',
  })
  assert.equal(payload.url, '/demo/chat')
  assert.equal(payload.data.target, 'customer')
})

test('admin chat push opens customer thread with userId', () => {
  const payload = buildChatPushPayload({
    shopSlug: 'demo',
    title: 'ข้อความใหม่จากลูกค้า',
    body: 'hello',
    userId: 'user-123',
    target: 'admin',
  })
  assert.equal(payload.url, '/demo/chat?userId=user-123')
  assert.equal(payload.data.target, 'admin')
})
