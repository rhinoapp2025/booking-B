const { getHotelSetting, setHotelSetting } = require('./hotelSettings')
const { resolveHotelMapEmbedUrl } = require('./googleMapEmbed')
const DEFAULT_CONTENT = require('./bookingSiteDefaultContent.json')

const CONTENT_KEY = 'booking_site_content'
const MAX_JSON_BYTES = 1_500_000

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CONTENT))
}

function logoFromName(name) {
  const compact = String(name || '').replace(/\s+/g, '').slice(0, 18)
  return compact || 'HOTEL'
}

function bookingPathForHotel(hotel) {
  const slug = String(hotel?.slug || '').trim().toLowerCase()
  return slug ? `/${slug}/bookings` : '/bookings'
}

function buildDefaultContent(hotel) {
  const content = cloneDefault()
  const name = String(hotel?.name || '').trim() || 'โรงแรม'
  content.site.name = name
  content.site.logoText = logoFromName(name)
  content.site.bookingUrl = bookingPathForHotel(hotel)
  if (hotel?.address) content.site.address = String(hotel.address)
  if (hotel?.phone) content.site.phone = String(hotel.phone)
  if (hotel?.email) content.site.email = String(hotel.email)
  return content
}

function withBookingFallback(content, hotel) {
  const next = content && typeof content === 'object' ? content : buildDefaultContent(hotel)
  if (!next.site || typeof next.site !== 'object') next.site = {}
  if (!String(next.site.bookingUrl || '').trim()) {
    next.site.bookingUrl = bookingPathForHotel(hotel)
  }
  return next
}

function parseStoredContent(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!parsed.site || !Array.isArray(parsed.hero) || !parsed.hero.length) return null
    return parsed
  } catch {
    return null
  }
}

function validateContent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'ข้อมูลไม่ถูกต้อง' }
  if (!body.site || typeof body.site !== 'object' || Array.isArray(body.site)) return { error: 'ข้อมูลไม่ถูกต้อง' }
  if (!Array.isArray(body.hero) || !body.hero.length) return { error: 'ข้อมูลไม่ถูกต้อง' }
  let json
  try {
    json = JSON.stringify(body)
  } catch {
    return { error: 'ข้อมูลไม่ถูกต้อง' }
  }
  if (json.length > MAX_JSON_BYTES) return { error: 'ข้อมูลใหญ่เกินไป' }
  return { content: JSON.parse(json) }
}

async function getBookingSiteContent(pool, hotel) {
  const raw = await getHotelSetting(pool, hotel.id, CONTENT_KEY)
  const stored = parseStoredContent(raw)
  return withBookingFallback(stored || buildDefaultContent(hotel), hotel)
}

async function resolveAboutMap(content) {
  const about = content.about
  if (!about || typeof about !== 'object') return
  const mapUrl = String(about.mapUrl || '').trim()
  about.mapUrl = mapUrl
  if (!/^https?:\/\//i.test(mapUrl)) {
    about.mapEmbedUrl = ''
    about.mapEmbedFor = ''
    return
  }
  if (about.mapEmbedFor === mapUrl && String(about.mapEmbedUrl || '').trim()) return
  try {
    about.mapEmbedUrl = (await resolveHotelMapEmbedUrl(mapUrl, '')) || ''
  } catch {
    about.mapEmbedUrl = ''
  }
  about.mapEmbedFor = about.mapEmbedUrl ? mapUrl : ''
}

async function saveBookingSiteContent(pool, hotel, body) {
  const checked = validateContent(body)
  if (checked.error) return checked
  const content = withBookingFallback(checked.content, hotel)
  await resolveAboutMap(content)
  await setHotelSetting(pool, hotel.id, CONTENT_KEY, JSON.stringify(content))
  return { content }
}

module.exports = {
  CONTENT_KEY,
  getBookingSiteContent,
  saveBookingSiteContent,
}
