const fs = require('fs')
const path = require('path')
const { getPool } = require('../db/pool')
const { HOTEL_RETURN, shapeHotel } = require('./hotelShape')
const { attachHotelBranding } = require('./hotelBranding')
const { logoIconVersion, hotelIconPublicUrl } = require('./hotelIcon')

const BOT_UA = /bot|crawler|spider|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|Telegram|Line|Applebot|Googlebot|SkypeUriPreview|Iframely|embedly/i
const SLUG_RE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/i
const RESERVED = new Set(['api', 'assets', 'health', 'favicon.png', 'favicon.svg', 'version.json', 'firebase-messaging-sw.js'])
const SHARE_FOLDERS = ['', 'bookings', 'booking-site', 'admin', path.join('admin', 'config')]

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

function siteOrigin() {
  return String(process.env.SITE_ORIGIN || process.env.PUBLIC_ORIGIN || 'https://theotel.app').replace(/\/$/, '')
}

function shareStaticDir() {
  return String(process.env.SHARE_STATIC_DIR || process.env.FRONTEND_DIST || '').trim()
}

function absoluteUrl(origin, pathValue) {
  const value = String(pathValue || '').trim()
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

function injectSpaSharePage(template, { title, description, image, url, favicon, apple }) {
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(description)
  const safeImage = escapeHtml(image)
  const safeUrl = escapeHtml(url)
  const safeFavicon = escapeHtml(favicon || image)
  const safeApple = escapeHtml(apple || favicon || image)
  let html = template.replace(/<title>[^<]*<\/title>/i, `<title>${safeTitle}</title>`)
  html = html.replace(/<link[^>]+rel="(?:shortcut icon|icon|apple-touch-icon)"[^>]*>\s*/gi, '')
  html = html.replace(/<meta[^>]+(?:name="description"|property="og:[^"]+")[^>]*>\s*/gi, '')
  const tags = [
    `<link rel="icon" type="image/png" sizes="32x32" href="${safeFavicon}">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${safeApple}">`,
    `<meta name="description" content="${safeDescription}">`,
    `<meta property="og:site_name" content="theotel">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${safeTitle}">`,
    `<meta property="og:description" content="${safeDescription}">`,
    `<meta property="og:url" content="${safeUrl}">`,
    `<meta property="og:image" content="${safeImage}">`,
  ].join('\n    ')
  return html.replace(/<\/title>/i, `</title>\n    ${tags}`)
}

async function hotelShareMetaFromSlug(slug, origin, publicPath) {
  const pool = getPool()
  const result = await pool.query(
    `SELECT ${HOTEL_RETURN} FROM hotels WHERE slug = $1 AND is_active = true`,
    [slug]
  )
  const pageUrl = `${origin}${publicPath || `/${slug}`}`
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

async function hotelShareMeta(req, slug) {
  const origin = requestOrigin(req)
  const publicPath = String(req.path || '').startsWith('/api/') ? `/${slug}` : req.path
  return hotelShareMetaFromSlug(slug, origin, publicPath)
}

function slugFromPath(pathValue) {
  const match = String(pathValue || '').match(SLUG_RE)
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

function writeShareFiles(distDir, slug, pageHtml) {
  for (const folder of SHARE_FOLDERS) {
    const targetDir = folder ? path.join(distDir, slug, folder) : path.join(distDir, slug)
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'index.html'), pageHtml)
  }
}

/**
 * เขียนหน้าแชร์ static ลง frontend dist (nginx เสิร์ฟตรง)
 * ตั้ง SHARE_STATIC_DIR หรือ FRONTEND_DIST ชี้ไปโฟลเดอร์ dist ของ booking-F
 */
async function writeHotelSharePage(slug) {
  const normalized = String(slug || '').trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return { ok: false, skipped: true, reason: 'invalid slug' }
  }
  const distDir = shareStaticDir()
  if (!distDir) {
    return { ok: false, skipped: true, reason: 'SHARE_STATIC_DIR not set' }
  }
  const templatePath = path.join(distDir, 'index.html')
  if (!fs.existsSync(templatePath)) {
    return { ok: false, skipped: true, reason: `missing ${templatePath}` }
  }
  const template = fs.readFileSync(templatePath, 'utf8')
  const origin = siteOrigin()
  const meta = await hotelShareMetaFromSlug(normalized, origin, `/${normalized}`)
  writeShareFiles(distDir, normalized, injectSpaSharePage(template, meta))
  return { ok: true, slug: normalized, dir: path.join(distDir, normalized) }
}

async function syncAllHotelSharePages() {
  const distDir = shareStaticDir()
  if (!distDir) {
    return { ok: false, skipped: true, reason: 'SHARE_STATIC_DIR not set', written: 0 }
  }
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    return { ok: false, skipped: true, reason: `missing ${path.join(distDir, 'index.html')}`, written: 0 }
  }
  const pool = getPool()
  const result = await pool.query(
    `SELECT slug FROM hotels WHERE is_active = true ORDER BY slug ASC`
  )
  let written = 0
  const errors = []
  for (const row of result.rows) {
    try {
      const out = await writeHotelSharePage(row.slug)
      if (out.ok) written += 1
      else if (!out.skipped) errors.push(`${row.slug}: ${out.reason || 'failed'}`)
    } catch (err) {
      errors.push(`${row.slug}: ${err.message}`)
    }
  }
  return { ok: errors.length === 0, written, total: result.rows.length, errors }
}

function scheduleHotelSharePageWrite(slug) {
  const label = String(slug || '').trim().toLowerCase()
  if (!label) return
  setImmediate(() => {
    writeHotelSharePage(label)
      .then((out) => {
        if (out.skipped) {
          if (out.reason && !/not set/i.test(out.reason)) {
            console.warn(`[share] skip ${label}: ${out.reason}`)
          }
          return
        }
        if (out.ok) console.log(`[share] wrote static pages for ${label}`)
      })
      .catch((err) => console.warn(`[share] write ${label} failed:`, err.message))
  })
}

function scheduleSyncAllHotelSharePages() {
  setImmediate(() => {
    syncAllHotelSharePages()
      .then((out) => {
        if (out.skipped) {
          console.log(`[share] static sync skipped (${out.reason})`)
          return
        }
        console.log(`[share] synced ${out.written}/${out.total} hotel preview pages`)
        if (out.errors?.length) console.warn('[share] sync errors:', out.errors.join('; '))
      })
      .catch((err) => console.warn('[share] sync failed:', err.message))
  })
}

module.exports = {
  shareBotMiddleware,
  sendHotelShare,
  isShareBot,
  writeHotelSharePage,
  syncAllHotelSharePages,
  scheduleHotelSharePageWrite,
  scheduleSyncAllHotelSharePages,
  shareStaticDir,
}
