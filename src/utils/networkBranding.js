const { parseBase64Image } = require('./chatImages')
const { getAppSettingsMap, setAppSettings } = require('./hotelFeatureFlags')
const { normalizeTheme, sanitizeThemeSettings, UI_THEME_KEYS } = require('./hotelTheme')
const { normalizeKind, saveUiImage, deleteUiImage, readUiImage } = require('./hotelBranding')

const PLATFORM_ID = 'platform'

const KEYS = {
  name: 'network_name',
  logo: 'network_logo_url',
  hero: 'network_hero_url',
  primary: 'network_color_primary',
  text: 'network_color_text',
  background: 'network_color_background',
  fontFamily: 'network_font_family',
  fontSize: 'network_font_size',
}

function publicNetworkImagePath(kind, filename) {
  if (!filename) return ''
  const safeKind = normalizeKind(kind)
  if (!safeKind) return ''
  return `/api/hotels/network-image/${safeKind}?v=${encodeURIComponent(filename)}`
}

function settingKeyForKind(kind) {
  const safeKind = normalizeKind(kind)
  if (safeKind === 'logo') return KEYS.logo
  if (safeKind === 'hero') return KEYS.hero
  return ''
}

async function getNetworkBranding(pool) {
  const map = await getAppSettingsMap(pool, Object.values(KEYS))
  const theme = normalizeTheme({
    ui_color_primary: map[KEYS.primary],
    ui_color_text: map[KEYS.text],
    ui_color_background: map[KEYS.background],
    ui_font_family: map[KEYS.fontFamily],
    ui_font_size: map[KEYS.fontSize],
  })
  const name = String(map[KEYS.name] || '').trim() || 'ค้นหาโรงแรม'
  return {
    name,
    logo_url: publicNetworkImagePath('logo', map[KEYS.logo]),
    hero_url: publicNetworkImagePath('hero', map[KEYS.hero]),
    theme,
  }
}

async function saveNetworkBranding(pool, body = {}) {
  const patch = {}
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    patch[KEYS.name] = String(body.name || '').trim()
  }
  const themeSrc = body.theme && typeof body.theme === 'object' && !Array.isArray(body.theme)
    ? body.theme
    : body
  const themePatch = {}
  for (const key of UI_THEME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(themeSrc, key)) themePatch[key] = themeSrc[key]
  }
  const clean = sanitizeThemeSettings(themePatch)
  if (clean.ui_color_primary) patch[KEYS.primary] = clean.ui_color_primary
  if (clean.ui_color_text) patch[KEYS.text] = clean.ui_color_text
  if (clean.ui_color_background) patch[KEYS.background] = clean.ui_color_background
  if (clean.ui_font_family) patch[KEYS.fontFamily] = clean.ui_font_family
  if (clean.ui_font_size) patch[KEYS.fontSize] = clean.ui_font_size
  if (Object.keys(patch).length) await setAppSettings(pool, patch)
  return getNetworkBranding(pool)
}

async function saveNetworkUiImage(pool, kind, imageData, imageMime) {
  const safeKind = normalizeKind(kind)
  const key = settingKeyForKind(safeKind)
  if (!key) return { error: 'kind ต้องเป็น logo หรือ hero', status: 400 }
  const parsed = parseBase64Image(imageData, imageMime)
  if (!parsed) return { error: 'imageData is required', status: 400 }
  if (parsed.error) return { error: parsed.error, status: 400 }
  const filename = await saveUiImage(PLATFORM_ID, safeKind, parsed.buffer, parsed.ext)
  await setAppSettings(pool, { [key]: filename })
  return {
    kind: safeKind,
    filename,
    url: publicNetworkImagePath(safeKind, filename),
  }
}

async function removeNetworkUiImage(pool, kind) {
  const safeKind = normalizeKind(kind)
  const key = settingKeyForKind(safeKind)
  if (!key) return { error: 'kind ต้องเป็น logo หรือ hero', status: 400 }
  await deleteUiImage(PLATFORM_ID, safeKind)
  await setAppSettings(pool, { [key]: '' })
  return { kind: safeKind, url: '' }
}

async function readNetworkUiImage(pool, kind) {
  const safeKind = normalizeKind(kind)
  const key = settingKeyForKind(safeKind)
  if (!key) return null
  const map = await getAppSettingsMap(pool, [key])
  const filename = String(map[key] || '').trim()
  if (!filename) return null
  return readUiImage(PLATFORM_ID, filename)
}

module.exports = {
  getNetworkBranding,
  saveNetworkBranding,
  saveNetworkUiImage,
  removeNetworkUiImage,
  readNetworkUiImage,
}
