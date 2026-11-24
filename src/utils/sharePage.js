const { getPool } = require('../db/pool')
const { HOTEL_RETURN, shapeHotel } = require('./hotelShape')
const { attachHotelBranding } = require('./hotelBranding')
const { logoIconVersion, hotelIconPublicUrl } = require('./hotelIcon')

const BOT_UA = /bot|crawler|spider|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|Telegram|Line|Applebot|Googlebot|SkypeUriPreview|Iframely|embedly/i
const SLUG_RE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/i
const RESERVED = new Set(['api', 'assets', 'health', 'favicon.png', 'favicon.svg', 'version.json', 'firebase-messaging-sw.js'])

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function requestOrigin(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim()
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim()
  return `${proto}://${host}`
}

function absoluteUrl(origin, path) {
  const value = String(path || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `${origin}${value.startsWith('/') ? value : `/${value}`}`
}

function shareHtml({ title, description, image, url, favicon, apple }) {
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(description)
  const safeUrl = escapeHtml(url)
  const safeImage = escapeHtml(image)
  const safeFavicon = escapeHtml(favicon || image)
  const safeApple = escapeHtml(apple || favicon || image)
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <link rel="icon" type="image/png" sizes="32x32" href="${safeFavicon}">
  <link rel="apple-touch-icon" sizes="180x180" href="${safeApple}">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <meta property="og:site_name" content="theotel">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${safeUrl}">
  <meta property="og:image" content="${safeImage}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  <meta name="twitter:image" content="${safeImage}">
  <link rel="canonical" href="${safeUrl}">
</head>
<body>
  <p><a href="${safeUrl}">${safeTitle}</a></p>
</body>
</html>`
}

async function hotelShareMeta(req, slug) {
  const pool = getPool()
  const result = await pool.query(
    `SELECT ${HOTEL_RETURN} FROM hotels WHERE slug = $1 AND is_active = true`,
    [slug]
  )
  const origin = requestOrigin(req)
  const publicPath = String(req.path || '').startsWith('/api/') ? `/${slug}` : req.path
  const pageUrl = `${origin}${publicPath}`
  if (!result.rows[0]) {
    return {
      title: 'theotel',
      description: 'จองห้องพักออนไลน์กับ theotel',
      image: `${origin}/favicon.png`,
      url: pageUrl,
    }
  }
  const hotel = await attachHotelBranding(pool, shapeHotel(result.rows[0]))
  const name = String(hotel.name || '').trim() || 'theotel'
  const description = String(hotel.description || '').replace(/\s+/g, ' ').trim() || `จองห้องพัก ${name}`
  let version = '0'
  try {
    version = logoIconVersion(new URL(hotel.logo_url || '', origin).searchParams.get('v') || '')
  } catch {
    version = '0'
  }
  const favicon = hotelIconPublicUrl(origin, slug, 32, version)
  const apple = hotelIconPublicUrl(origin, slug, 180, version)
  const image = absoluteUrl(origin, hotel.logo_url || hotel.login_image_url) || hotelIconPublicUrl(origin, slug, 512, version)
  return { title: name, description, image, url: pageUrl, favicon, apple }
}

function slugFromPath(path) {
  const match = String(path || '').match(SLUG_RE)
  if (!match) return ''
  const slug = match[1].toLowerCase()
  if (RESERVED.has(slug)) return ''
  return slug
}

function isShareBot(req) {
  return BOT_UA.test(req.get('user-agent') || '')
}

async function sendHotelShare(req, res, slug) {
  const meta = await hotelShareMeta(req, slug)
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.set('Cache-Control', 'public, max-age=300')
  if (req.method === 'HEAD') return res.end()
  return res.send(shareHtml(meta))
}

async function shareBotMiddleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  if (!isShareBot(req)) return next()
  const slug = slugFromPath(req.path)
  if (!slug) return next()
  try {
    return await sendHotelShare(req, res, slug)
  } catch (err) {
    console.warn('[share] preview failed:', err.message)
    return next()
  }
}

module.exports = {
  shareBotMiddleware,
  sendHotelShare,
  isShareBot,
}
