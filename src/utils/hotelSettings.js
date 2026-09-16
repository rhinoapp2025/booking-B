const { getPool } = require('../db/pool')

const DEFAULTS = {
  deposit_percent:          '30',
  auto_cancel_hours:        '24',
  cancellation_policy:      '',
  non_smoking:              'false',
  non_smoking_fine:         '0',
  require_id_card:          'false',
  book_advance_days:        '90',
  coupon_discount_percent:  '10',
  coupon_required_points:   '100',
  coupon_completion_points: '5',
  unpaid_auto_cancel_enabled: 'true',
  payment_collect_mode:       'deposit',
  service_charge_percent:     '0',
  vat_percent:                '0',
  promptpay_number:         '',
  bank_name:                '',
  bank_account_name:        '',
  bank_account_no:          '',
  ui_color_primary:         '#001529',
  ui_color_text:            '#1A2332',
  ui_color_background:      '#F0F2F5',
  ui_font_family:           'noto',
  ui_font_size:             'md',
}

async function getHotelSetting(poolOrClient, hotelId, key) {
  const db = poolOrClient || await getPool()
  const result = await db.query(
    `SELECT setting_value FROM hotel_settings WHERE hotel_id = $1 AND setting_key = $2`,
    [hotelId, key]
  )
  return result.rows[0]?.setting_value ?? DEFAULTS[key] ?? null
}

async function getHotelSettings(poolOrClient, hotelId, keys) {
  const db = poolOrClient || await getPool()
  const result = await db.query(
    `SELECT setting_key, setting_value FROM hotel_settings
     WHERE hotel_id = $1 AND setting_key = ANY($2)`,
    [hotelId, keys]
  )
  const map = { ...Object.fromEntries(keys.map(k => [k, DEFAULTS[k] ?? null])) }
  for (const row of result.rows) map[row.setting_key] = row.setting_value
  return map
}

async function setHotelSetting(poolOrClient, hotelId, key, value) {
  const db = poolOrClient || await getPool()
  await db.query(
    `INSERT INTO hotel_settings (hotel_id, setting_key, setting_value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (hotel_id, setting_key)
     DO UPDATE SET setting_value = $3, updated_at = NOW()`,
    [hotelId, key, value]
  )
}

async function setHotelSettings(poolOrClient, hotelId, kvMap) {
  for (const [key, value] of Object.entries(kvMap)) {
    await setHotelSetting(poolOrClient, hotelId, key, value)
  }
}

module.exports = { getHotelSetting, getHotelSettings, setHotelSetting, setHotelSettings, DEFAULTS }
