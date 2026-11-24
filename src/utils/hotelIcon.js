const sharp = require('sharp')
const { readUiImage } = require('./hotelBranding')

const ICON_SIZES = new Set([32, 180, 192, 512])
const memoryCache = new Map()
const CACHE_MAX_ENTRIES = 100

function logoIconVersion(logoFile) {
  const logo = String(logoFile || '').trim()
  if (!logo) return '0'
  const base = logo.split('/').pop().split('?')[0]
  const stem = base.replace(/\.[^.]+$/, '')
  return stem.slice(0, 24) || '0'
}

function parseIconSize(raw) {
  const size = Number.parseInt(String(raw || ''), 10)
  return ICON_SIZES.has(size) ? size : null
}

function hotelIconPublicUrl(apiBase, slug, size, version) {
  const base = String(apiBase || '').replace(/\/$/, '')
  const v = version != null && version !== '' ? `?v=${encodeURIComponent(String(version))}` : ''
  return `${base}/api/hotels/${encodeURIComponent(slug)}/icon/${size}.png${v}`
}

function parseHexColor(color, fallback = '#001529') {
  const c = String(color || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  return fallback
}

function escapeSvgText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function renderFallbackIcon(hotelName, primaryColor, size) {
  const letter = String(hotelName || 'H').trim().charAt(0).toUpperCase() || 'H'
  const bg = parseHexColor(primaryColor)
  const fontSize = Math.round(size * 0.44)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="${bg}"/>
    <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#FFFFFF" font-family="Arial,sans-serif" font-weight="600" font-size="${fontSize}">${escapeSvgText(letter)}</text>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

async function cropLogoToSquarePng(sourceBuffer, size) {
  return sharp(sourceBuffer, { animated: false })
    .rotate()
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

function remember(key, buffer) {
  if (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const first = memoryCache.keys().next().value
    memoryCache.delete(first)
  }
  memoryCache.set(key, buffer)
}

async function renderHotelIconPng({ hotelId, hotelName, logoFilename, primaryColor, size }) {
  const version = logoIconVersion(logoFilename)
  const cacheKey = `${hotelId}:${size}:${version}`
  const cached = memoryCache.get(cacheKey)
  if (cached) return cached

  const file = logoFilename ? await readUiImage(hotelId, logoFilename) : null
  let png
  if (file?.buffer) {
    try {
      png = await cropLogoToSquarePng(file.buffer, size)
    } catch {
      png = await renderFallbackIcon(hotelName, primaryColor, size)
    }
  } else {
    png = await renderFallbackIcon(hotelName, primaryColor, size)
  }
  remember(cacheKey, png)
  return png
}

function buildHotelBranding(origin, hotel, logoFilename) {
  const version = logoIconVersion(logoFilename)
  return {
    name: String(hotel?.name || '').trim(),
    slug: hotel?.slug,
    icon_version: version,
    icons: {
      favicon: hotelIconPublicUrl(origin, hotel.slug, 32, version),
      apple: hotelIconPublicUrl(origin, hotel.slug, 180, version),
      pwa192: hotelIconPublicUrl(origin, hotel.slug, 192, version),
      pwa512: hotelIconPublicUrl(origin, hotel.slug, 512, version),
    },
  }
}

module.exports = {
  ICON_SIZES,
  logoIconVersion,
  parseIconSize,
  hotelIconPublicUrl,
  renderHotelIconPng,
  buildHotelBranding,
}
