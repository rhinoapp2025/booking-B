const test = require('node:test')
const assert = require('node:assert/strict')
const { parseBase64Image } = require('../src/utils/usageRenewalSlips')
const { bookingSlipPath } = require('../src/utils/bookingPaymentSlips')
const {
  parseRetentionDays,
  DEFAULT_RETENTION_DAYS,
} = require('../src/utils/bookingPaymentSlipSettings')
const { mergeUiSettings } = require('../src/utils/shopUiSettings')

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('parseBase64Image accepts png data url', () => {
  const parsed = parseBase64Image(`data:image/png;base64,${TINY_PNG_B64}`, 'image/png')
  assert.ok(parsed.buffer)
  assert.equal(parsed.ext, 'png')
})

test('parseBase64Image rejects unsupported mime', () => {
  const parsed = parseBase64Image(TINY_PNG_B64, 'image/bmp')
  assert.equal(parsed.error, 'รองรับเฉพาะ JPG, PNG, WebP, GIF')
})

test('parseBase64Image rejects empty payload', () => {
  assert.equal(parseBase64Image('', 'image/png'), null)
})

test('bookingSlipPath blocks path traversal', () => {
  assert.equal(bookingSlipPath('../secret.txt'), null)
  assert.equal(bookingSlipPath('valid-file.jpg')?.endsWith('valid-file.jpg'), true)
})

test('parseRetentionDays clamps to 1–90', () => {
  assert.equal(parseRetentionDays('0'), DEFAULT_RETENTION_DAYS)
  assert.equal(parseRetentionDays('3'), 3)
  assert.equal(parseRetentionDays('999'), 90)
  assert.equal(parseRetentionDays('abc'), DEFAULT_RETENTION_DAYS)
})

test('mergeUiSettings keeps slip upload default off', () => {
  const ui = mergeUiSettings({})
  assert.equal(ui.ui_payment_slip_upload_enabled, '0')
})

test('mergeUiSettings accepts slip upload enabled', () => {
  const ui = mergeUiSettings({ ui_payment_slip_upload_enabled: '1' })
  assert.equal(ui.ui_payment_slip_upload_enabled, '1')
})
