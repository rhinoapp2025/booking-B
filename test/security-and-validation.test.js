const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { verifyLineSignature } = require('../src/utils/lineWebhookVerify')
const { normalizeChatBody } = require('../src/utils/chatAccess')
const { parseStoredUiImagePath } = require('../src/utils/shopUiImages')

test('verifyLineSignature accepts valid HMAC', () => {
  const secret = 'test-channel-secret'
  const body = Buffer.from('{"events":[]}', 'utf8')
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64')
  assert.equal(verifyLineSignature(body, signature, secret), true)
})

test('verifyLineSignature rejects wrong secret', () => {
  const body = Buffer.from('{"events":[]}', 'utf8')
  const signature = crypto.createHmac('sha256', 'a').update(body).digest('base64')
  assert.equal(verifyLineSignature(body, signature, 'b'), false)
})

test('normalizeChatBody trims and caps length', () => {
  assert.equal(normalizeChatBody('  hello  '), 'hello')
  assert.equal(normalizeChatBody(''), '')
  assert.equal(normalizeChatBody('x'.repeat(2500)).length, 2000)
})

test('parseStoredUiImagePath extracts kind and filename', () => {
  const parsed = parseStoredUiImagePath('/api/bookings/ui-images/logo/abc.png')
  assert.deepEqual(parsed, { kind: 'logo', filename: 'abc.png' })
  assert.equal(parseStoredUiImagePath('https://evil.com/logo.png'), null)
})
