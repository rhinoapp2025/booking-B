const { getHotelSettings, setHotelSettings } = require('./hotelSettings')

const SETTING_KEYS = [
  'chat_notify_new_booking_enabled',
  'chat_notify_confirm_customer_enabled',
  'chat_notify_upcoming_admin_enabled',
  'chat_notify_upcoming_customer_enabled',
  'chat_notify_upcoming_minutes',
  'chat_notify_cancel_admin_enabled',
  'chat_notify_cancel_customer_enabled',
  'chat_notify_slip_admin_enabled',
  'chat_notify_new_booking_template',
  'chat_notify_confirm_customer_template',
  'chat_notify_upcoming_admin_template',
  'chat_notify_upcoming_customer_template',
  'chat_notify_cancel_admin_template',
  'chat_notify_cancel_customer_template',
  'chat_notify_slip_admin_template',
]

const DEFAULT_NEW_BOOKING_TEMPLATE =
  `🔔 มีการจองใหม่\n👤 {guestName}\n📅 เช็คอิน: {checkInDate}  เช็คเอาต์: {checkOutDate}\n🆔 {bookingId}`
const DEFAULT_CONFIRM_CUSTOMER_TEMPLATE =
  `✅ ยืนยันการจองของคุณแล้ว\n📅 เช็คอิน: {checkInDate}  เช็คเอาต์: {checkOutDate}`
const DEFAULT_UPCOMING_ADMIN_TEMPLATE =
  `⏰ แขกเช็คอินวันนี้\n👤 {guestName}\n📅 เช็คอิน: {checkInDate}\n🆔 {bookingId}`
const DEFAULT_UPCOMING_CUSTOMER_TEMPLATE =
  `⏰ วันนี้คือวันเช็คอินของคุณ\n📅 {checkInDate} → {checkOutDate}`
const DEFAULT_CANCEL_ADMIN_TEMPLATE =
  `❌ การจองถูกยกเลิก\n👤 {guestName}\n📅 {checkInDate}→{checkOutDate}\n🆔 {bookingId}`
const DEFAULT_CANCEL_CUSTOMER_TEMPLATE =
  `❌ การจองของคุณถูกยกเลิก\n📅 {checkInDate}→{checkOutDate}`
const DEFAULT_SLIP_ADMIN_TEMPLATE =
  `💳 มีสลิปรอตรวจ\n👤 {guestName}\n📅 {checkInDate}→{checkOutDate}\n🆔 {bookingId}`

function parseEnabled(value, defaultTrue = true) {
  if (value == null || value === '') return defaultTrue
  return value !== 'false'
}

function parseMinutes(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) return 180
  if (n > 24 * 60) return 24 * 60
  return n
}

async function getChatNotifySettings(poolOrClient, hotelId) {
  const map = await getHotelSettings(poolOrClient, hotelId, SETTING_KEYS)
  return {
    newBookingEnabled:        parseEnabled(map.chat_notify_new_booking_enabled),
    confirmCustomerEnabled:   parseEnabled(map.chat_notify_confirm_customer_enabled),
    upcomingAdminEnabled:     parseEnabled(map.chat_notify_upcoming_admin_enabled),
    upcomingCustomerEnabled:  parseEnabled(map.chat_notify_upcoming_customer_enabled),
    upcomingMinutes:          parseMinutes(map.chat_notify_upcoming_minutes),
    cancelAdminEnabled:       parseEnabled(map.chat_notify_cancel_admin_enabled),
    cancelCustomerEnabled:    parseEnabled(map.chat_notify_cancel_customer_enabled),
    slipAdminEnabled:         parseEnabled(map.chat_notify_slip_admin_enabled),
    newBookingTemplate:       map.chat_notify_new_booking_template       || DEFAULT_NEW_BOOKING_TEMPLATE,
    confirmCustomerTemplate:  map.chat_notify_confirm_customer_template  || DEFAULT_CONFIRM_CUSTOMER_TEMPLATE,
    upcomingAdminTemplate:    map.chat_notify_upcoming_admin_template    || DEFAULT_UPCOMING_ADMIN_TEMPLATE,
    upcomingCustomerTemplate: map.chat_notify_upcoming_customer_template || DEFAULT_UPCOMING_CUSTOMER_TEMPLATE,
    cancelAdminTemplate:      map.chat_notify_cancel_admin_template      || DEFAULT_CANCEL_ADMIN_TEMPLATE,
    cancelCustomerTemplate:   map.chat_notify_cancel_customer_template   || DEFAULT_CANCEL_CUSTOMER_TEMPLATE,
    slipAdminTemplate:        map.chat_notify_slip_admin_template        || DEFAULT_SLIP_ADMIN_TEMPLATE,
  }
}

async function setChatNotifySettings(poolOrClient, hotelId, partial) {
  const entries = {}
  const bools = {
    newBookingEnabled:       'chat_notify_new_booking_enabled',
    confirmCustomerEnabled:  'chat_notify_confirm_customer_enabled',
    upcomingAdminEnabled:    'chat_notify_upcoming_admin_enabled',
    upcomingCustomerEnabled: 'chat_notify_upcoming_customer_enabled',
    cancelAdminEnabled:      'chat_notify_cancel_admin_enabled',
    cancelCustomerEnabled:   'chat_notify_cancel_customer_enabled',
    slipAdminEnabled:        'chat_notify_slip_admin_enabled',
  }
  for (const [k, dbKey] of Object.entries(bools)) {
    if (typeof partial[k] === 'boolean') entries[dbKey] = partial[k] ? 'true' : 'false'
  }
  if (partial.upcomingMinutes != null) entries.chat_notify_upcoming_minutes = String(parseMinutes(partial.upcomingMinutes))
  const templates = {
    newBookingTemplate:       'chat_notify_new_booking_template',
    confirmCustomerTemplate:  'chat_notify_confirm_customer_template',
    upcomingAdminTemplate:    'chat_notify_upcoming_admin_template',
    upcomingCustomerTemplate: 'chat_notify_upcoming_customer_template',
    cancelAdminTemplate:      'chat_notify_cancel_admin_template',
    cancelCustomerTemplate:   'chat_notify_cancel_customer_template',
    slipAdminTemplate:        'chat_notify_slip_admin_template',
  }
  for (const [k, dbKey] of Object.entries(templates)) {
    if (partial[k] != null) entries[dbKey] = String(partial[k])
  }
  if (Object.keys(entries).length) await setHotelSettings(poolOrClient, hotelId, entries)
  return getChatNotifySettings(poolOrClient, hotelId)
}

module.exports = {
  SETTING_KEYS, getChatNotifySettings, setChatNotifySettings,
  DEFAULT_NEW_BOOKING_TEMPLATE, DEFAULT_CONFIRM_CUSTOMER_TEMPLATE, DEFAULT_UPCOMING_ADMIN_TEMPLATE,
  DEFAULT_UPCOMING_CUSTOMER_TEMPLATE, DEFAULT_CANCEL_ADMIN_TEMPLATE,
  DEFAULT_CANCEL_CUSTOMER_TEMPLATE, DEFAULT_SLIP_ADMIN_TEMPLATE,
}
