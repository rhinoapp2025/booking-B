const fs = require('fs').promises
const path = require('path')
const { getUiUploadRoot } = require('./uploadPaths')
const { parseBase64Image } = require('./chatImages')
const { getHotelSettings, setHotelSetting } = require('./hotelSettings')

const KIND_SETTING = {
  logo: 'ui_logo_url',
  hero: 'ui_hero_image_url',
  banner: 'ui_banner_image_url',
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

function normalizeKind(kind) {
  const k = String(kind || '').trim().toLowerCase()
  if (k === 'login' || k === 'login_image') return 'hero'
  if (k === 'cover' || k === 'search_banner' || k === 'page_banner') return 'banner'
  if (k === 'logo' || k === 'hero' || k === 'banner') return k
  return ''
}

function settingKeyForKind(kind) {
  return KIND_SETTING[normalizeKind(kind)] || ''
}

function hotelUiDir(hotelId) {
  return path.join(getUiUploadRoot(), String(hotelId))
}

function publicUiImagePath(slug, kind, filename) {
  if (!filename) return ''
  const safeKind = normalizeKind(kind)
  if (!safeKind) return ''
  return `/api/hotels/${encodeURIComponent(slug)}/ui-image/${safeKind}?v=${encodeURIComponent(filename)}`
}

async function listKindFiles(hotelId, kind) {
  const dir = hotelUiDir(hotelId)
  const prefix = `${normalizeKind(kind)}.`
  try {
    const names = await fs.readdir(dir)
    return names.filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}

async function saveUiImage(hotelId, kind, buffer, ext) {
  const safeKind = normalizeKind(kind)
  if (!safeKind) throw new Error('kind ต้องเป็น logo, hero หรือ banner')
  const dir = hotelUiDir(hotelId)
  await fs.mkdir(dir, { recursive: true })
  const oldFiles = await listKindFiles(hotelId, safeKind)
  const filename = `${safeKind}.${Date.now()}.${ext}`
  await fs.writeFile(path.join(dir, filename), buffer)
  await Promise.all(
    oldFiles
      .filter((name) => name !== filename)
      .map((name) => fs.unlink(path.join(dir, name)).catch(() => null))
  )
  return filename
}

async function deleteUiImage(hotelId, kind) {
  const files = await listKindFiles(hotelId, kind)
  await Promise.all(files.map((name) => fs.unlink(path.join(hotelUiDir(hotelId), name)).catch(() => null)))
}

async function readUiImage(hotelId, filename) {
  const safeName = path.basename(String(filename || ''))
  if (!safeName || safeName !== filename || safeName.includes('..')) return null
  try {
    const buffer = await fs.readFile(path.join(hotelUiDir(hotelId), safeName))
    const ext = path.extname(safeName).slice(1).toLowerCase()
    return { buffer, ext, mime: MIME_BY_EXT[ext] || 'application/octet-stream' }
  } catch {
    return null
  }
}

async function getHotelBranding(pool, hotel) {
  const map = await getHotelSettings(pool, hotel.id, ['ui_logo_url', 'ui_hero_image_url', 'ui_banner_image_url'])
  return {
    logo_url: publicUiImagePath(hotel.slug, 'logo', map.ui_logo_url),
    login_image_url: publicUiImagePath(hotel.slug, 'hero', map.ui_hero_image_url),
    banner_url: publicUiImagePath(hotel.slug, 'banner', map.ui_banner_image_url),
  }
}

function applyHotelBranding(hotel, branding = {}) {
  if (!hotel) return hotel
  hotel.logo_url = branding.logo_url || ''
  hotel.login_image_url = branding.login_image_url || ''
  hotel.banner_url = branding.banner_url || ''
  return hotel
}

async function attachHotelBranding(pool, hotel) {
  return applyHotelBranding(hotel, await getHotelBranding(pool, hotel))
}

async function attachHotelsBranding(pool, hotels) {
  if (!hotels?.length) return hotels
  const ids = hotels.map((h) => h.id)
  const result = await pool.query(
    `SELECT hotel_id, setting_key, setting_value
     FROM hotel_settings
     WHERE hotel_id = ANY($1) AND setting_key = ANY($2)`,
    [ids, ['ui_logo_url', 'ui_hero_image_url', 'ui_banner_image_url']]
  )
  const byHotel = {}
  for (const row of result.rows) {
    if (!byHotel[row.hotel_id]) byHotel[row.hotel_id] = {}
    byHotel[row.hotel_id][row.setting_key] = row.setting_value
  }
  for (const hotel of hotels) {
    const map = byHotel[hotel.id] || {}
    applyHotelBranding(hotel, {
      logo_url: publicUiImagePath(hotel.slug, 'logo', map.ui_logo_url),
      login_image_url: publicUiImagePath(hotel.slug, 'hero', map.ui_hero_image_url),
      banner_url: publicUiImagePath(hotel.slug, 'banner', map.ui_banner_image_url),
    })
  }
  return hotels
}

async function saveHotelUiImage(pool, hotel, kind, imageData, imageMime) {
  const safeKind = normalizeKind(kind)
  const key = settingKeyForKind(safeKind)
  if (!key) return { error: 'kind ต้องเป็น logo, hero หรือ banner', status: 400 }
  const parsed = parseBase64Image(imageData, imageMime)
  if (!parsed) return { error: 'imageData is required', status: 400 }
  if (parsed.error) return { error: parsed.error, status: 400 }
  const filename = await saveUiImage(hotel.id, safeKind, parsed.buffer, parsed.ext)
  await setHotelSetting(pool, hotel.id, key, filename)
  return {
    kind: safeKind,
    filename,
    url: publicUiImagePath(hotel.slug, safeKind, filename),
  }
}

async function removeHotelUiImage(pool, hotel, kind) {
  const safeKind = normalizeKind(kind)
  const key = settingKeyForKind(safeKind)
  if (!key) return { error: 'kind ต้องเป็น logo, hero หรือ banner', status: 400 }
  await deleteUiImage(hotel.id, safeKind)
  await setHotelSetting(pool, hotel.id, key, '')
  return { kind: safeKind, url: '' }
}

module.exports = {
  normalizeKind,
  settingKeyForKind,
  publicUiImagePath,
  saveUiImage,
  deleteUiImage,
  readUiImage,
  getHotelBranding,
  applyHotelBranding,
  attachHotelBranding,
  attachHotelsBranding,
  saveHotelUiImage,
  removeHotelUiImage,
}
