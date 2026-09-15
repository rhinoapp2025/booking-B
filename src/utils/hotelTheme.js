const { getHotelSettings } = require('./hotelSettings')

const UI_THEME_KEYS = [
  'ui_color_primary',
  'ui_color_text',
  'ui_color_background',
  'ui_font_family',
  'ui_font_size',
]

const DEFAULT_THEME = {
  ui_color_primary: '#001529',
  ui_color_text: '#1A2332',
  ui_color_background: '#F0F2F5',
  ui_font_family: 'noto',
  ui_font_size: 'md',
}

const FONT_FAMILIES = new Set(['noto', 'sarabun', 'prompt', 'kanit', 'ibm', 'system'])
const FONT_SIZES = new Set(['sm', 'md', 'lg', 'xl'])

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim()
  const short = raw.match(/^#([0-9a-fA-F]{3})$/)
  if (short) {
    const [r, g, b] = short[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  const full = raw.match(/^#([0-9a-fA-F]{6})$/)
  if (full) return `#${full[1]}`.toUpperCase()
  return fallback
}

function normalizeFontFamily(value) {
  const key = String(value || '').trim().toLowerCase()
  return FONT_FAMILIES.has(key) ? key : DEFAULT_THEME.ui_font_family
}

function normalizeFontSize(value) {
  const key = String(value || '').trim().toLowerCase()
  return FONT_SIZES.has(key) ? key : DEFAULT_THEME.ui_font_size
}

function normalizeTheme(map = {}) {
  return {
    ui_color_primary: normalizeHex(map.ui_color_primary, DEFAULT_THEME.ui_color_primary),
    ui_color_text: normalizeHex(map.ui_color_text, DEFAULT_THEME.ui_color_text),
    ui_color_background: normalizeHex(map.ui_color_background, DEFAULT_THEME.ui_color_background),
    ui_font_family: normalizeFontFamily(map.ui_font_family),
    ui_font_size: normalizeFontSize(map.ui_font_size),
  }
}

function sanitizeThemeSettings(patch = {}) {
  const out = { ...patch }
  if (Object.prototype.hasOwnProperty.call(out, 'ui_color_primary')) {
    out.ui_color_primary = normalizeHex(out.ui_color_primary, DEFAULT_THEME.ui_color_primary)
  }
  if (Object.prototype.hasOwnProperty.call(out, 'ui_color_text')) {
    out.ui_color_text = normalizeHex(out.ui_color_text, DEFAULT_THEME.ui_color_text)
  }
  if (Object.prototype.hasOwnProperty.call(out, 'ui_color_background')) {
    out.ui_color_background = normalizeHex(out.ui_color_background, DEFAULT_THEME.ui_color_background)
  }
  if (Object.prototype.hasOwnProperty.call(out, 'ui_font_family')) {
    out.ui_font_family = normalizeFontFamily(out.ui_font_family)
  }
  if (Object.prototype.hasOwnProperty.call(out, 'ui_font_size')) {
    out.ui_font_size = normalizeFontSize(out.ui_font_size)
  }
  return out
}

async function getHotelTheme(pool, hotelId) {
  const map = await getHotelSettings(pool, hotelId, UI_THEME_KEYS)
  return normalizeTheme(map)
}

async function attachHotelTheme(pool, hotel) {
  if (!hotel) return hotel
  hotel.theme = await getHotelTheme(pool, hotel.id)
  return hotel
}

module.exports = {
  UI_THEME_KEYS,
  DEFAULT_THEME,
  FONT_FAMILIES,
  FONT_SIZES,
  normalizeHex,
  normalizeFontFamily,
  normalizeFontSize,
  normalizeTheme,
  sanitizeThemeSettings,
  getHotelTheme,
  attachHotelTheme,
}
