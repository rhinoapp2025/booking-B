const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  SETTING_KEYS,
  DEFAULT_SLIP_ADMIN_TEMPLATE,
  DEFAULT_CONFIRM_CUSTOMER_TEMPLATE,
} = require('../src/utils/chatNotifySettings')

test('chat notify settings include slip admin keys', () => {
  assert.ok(SETTING_KEYS.includes('chat_notify_slip_admin_enabled'))
  assert.ok(SETTING_KEYS.includes('chat_notify_slip_admin_template'))
})

test('chat notify settings include guest confirmation keys', () => {
  assert.ok(SETTING_KEYS.includes('chat_notify_confirm_customer_enabled'))
  assert.ok(SETTING_KEYS.includes('chat_notify_confirm_customer_template'))
  assert.match(DEFAULT_CONFIRM_CUSTOMER_TEMPLATE, /ยืนยันการจอง/)
})

test('default slip admin template mentions slip review', () => {
  assert.match(DEFAULT_SLIP_ADMIN_TEMPLATE, /สลิป/)
  assert.match(DEFAULT_SLIP_ADMIN_TEMPLATE, /\{bookingId\}/)
})

test('cancel notify to guest uses customer template', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/utils/bookingChatNotify.js'),
    'utf8'
  )
  assert.match(
    src,
    /if \(settings\.cancelCustomerEnabled\) \{\s*const text = applyTemplate\(settings\.cancelCustomerTemplate/
  )
})

test('system chat messages go to the system user thread', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/utils/bookingChatNotify.js'),
    'utf8'
  )
  assert.match(src, /userId:\s*systemUserId/)
  assert.match(src, /senderRole:\s*'system'/)
})

test('guest confirmation is sent as an admin message to the customer', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/utils/bookingChatNotify.js'),
    'utf8'
  )
  assert.match(src, /confirmCustomerEnabled/)
  assert.match(src, /title: 'ยืนยันการจอง'/)
})
