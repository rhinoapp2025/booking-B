const { sanitizeThemeSettings } = require('./hotelTheme')
const { normalizeLocationType, locationTypeLabel } = require('../constants/hotelLocationTypes')

const HOTEL_RETURN = `
  id, slug, name, description,
  address, city, province, country,
  phone, email, website, line_url,
  star_rating, check_in_time, check_out_time,
  cover_image, images, map_url, map_embed_url, location_type, about_hotel,
  is_active, created_at
`

const HOTEL_INFO_FIELDS = [
  'name', 'description', 'address', 'city', 'province', 'country',
  'phone', 'email', 'website', 'line_url', 'star_rating',
  'check_in_time', 'check_out_time', 'map_url', 'map_embed_url',
  'location_type', 'about_hotel', 'cover_image', 'is_active',
]

const CONFIG_SETTING_KEYS = [
  'promptpay_number',
  'bank_name',
  'bank_account_name',
  'bank_account_no',
  'deposit_percent',
  'payment_collect_mode',
  'service_charge_percent',
  'vat_percent',
  'auto_cancel_hours',
  'unpaid_auto_cancel_enabled',
  'cancellation_policy',
  'non_smoking',
  'non_smoking_fine',
  'require_id_card',
  'book_advance_days',
  'coupon_discount_percent',
  'coupon_required_points',
  'coupon_completion_points',
  'ui_color_primary',
  'ui_color_text',
  'ui_color_background',
  'ui_font_family',
  'ui_font_size',
]

function shapeHotel(row) {
  if (!row) return null
  const shaped = { ...row }
  shaped.location_type = normalizeLocationType(shaped.location_type)
  shaped.location_type_label = locationTypeLabel(shaped.location_type) || null
  shaped.about_hotel = shaped.about_hotel == null ? '' : String(shaped.about_hotel)
  shaped.line_url = shaped.line_url == null ? '' : String(shaped.line_url)
  return shaped
}

async function shapeHotelWithCatalog(pool, row) {
  if (!row) return null
  const { attachCatalogLabels } = require('./hotelCatalogOptions')
  const base = shapeHotel(row)
  return attachCatalogLabels(pool, base.id, base)
}

function pickHotelFields(body) {
  const src = body?.hotel && typeof body.hotel === 'object' ? body.hotel : body
  const patch = {}
  for (const key of HOTEL_INFO_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    if (key === 'location_type') {
      patch.location_type = normalizeLocationType(src[key])
      continue
    }
    if (key === 'about_hotel') {
      const text = String(src[key] ?? '').trim()
      patch.about_hotel = text || null
      continue
    }
    if (key === 'line_url') {
      const text = String(src[key] ?? '').trim()
      patch.line_url = text || null
      continue
    }
    if (key === 'star_rating') {
      const n = Number(src[key])
      patch.star_rating = Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.round(n)) : null
      continue
    }
    patch[key] = src[key]
  }
  return patch
}

function pickConfigSettings(body) {
  const src = body?.settings && typeof body.settings === 'object' ? body.settings : body
  const patch = {}
  const { sanitizePercentSetting } = require('./stayCharges')
  for (const key of CONFIG_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    if (key === 'service_charge_percent' || key === 'vat_percent') {
      patch[key] = sanitizePercentSetting(src[key])
      continue
    }
    patch[key] = src[key] == null ? '' : String(src[key])
  }
  return sanitizeThemeSettings(patch)
}

module.exports = {
  HOTEL_RETURN,
  HOTEL_INFO_FIELDS,
  CONFIG_SETTING_KEYS,
  shapeHotel,
  shapeHotelWithCatalog,
  pickHotelFields,
  pickConfigSettings,
}
