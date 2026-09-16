const fs     = require('fs').promises
const path   = require('path')
const crypto = require('crypto')
const { getChatUploadRoot } = require('./uploadPaths')

const MAX_BYTES                  = 2 * 1024 * 1024
const DEFAULT_RETENTION_HOURS   = 24
const DEFAULT_CACHE_MAX_AGE_SEC = 86400

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
}

function getChatImageRetentionHours() {
  const h = Number(process.env.CHAT_IMAGE_RETENTION_HOURS)
  return Number.isFinite(h) && h > 0 ? h : DEFAULT_RETENTION_HOURS
}

function getChatImageCacheMaxAge() {
  const s = Number(process.env.CHAT_IMAGE_CACHE_MAX_AGE)
  return Number.isFinite(s) && s > 0 ? Math.floor(s) : DEFAULT_CACHE_MAX_AGE_SEC
}

function parseBase64Image(imageData, imageMime) {
  if (!imageData) return null

  let b64 = String(imageData)
  const match = b64.match(/^data:([^;]+);base64,(.+)$/i)
  const mimeFromData = match ? String(match[1] || '').toLowerCase().trim() : ''
  if (match) b64 = match[2]

  let mime = String(imageMime || mimeFromData || '').toLowerCase().trim()
  if (mime === 'image/jpg' || mime === 'image/pjpeg') mime = 'image/jpeg'
  const ext  = MIME_EXT[mime]
  if (!ext) return { error: 'รองรับเฉพาะ JPG, PNG, WebP, GIF' }

  let buffer
  try { buffer = Buffer.from(b64, 'base64') } catch { return { error: 'รูปภาพไม่ถูกต้อง' } }
  if (!buffer.length) return { error: 'รูปภาพว่าง' }
  if (buffer.length > MAX_BYTES) return { error: 'รูปใหญ่เกิน 2MB' }
  return { buffer, ext, mime }
}

function hotelImagePath(hotelId, filename) {
  const safeName = path.basename(String(filename || ''))
  if (!safeName || safeName !== filename || safeName.includes('..')) return null
  return path.join(getChatUploadRoot(), String(hotelId), safeName)
}

async function saveChatImage(hotelId, buffer, ext) {
  const dir = path.join(getChatUploadRoot(), String(hotelId))
  await fs.mkdir(dir, { recursive: true })
  const filename = `${crypto.randomUUID()}.${ext}`
  await fs.writeFile(path.join(dir, filename), buffer)
  return filename
}

async function deleteChatImageFile(hotelId, filename) {
  const filePath = hotelImagePath(hotelId, filename)
  if (!filePath) return
  try { await fs.unlink(filePath) } catch { /* ignore */ }
}

async function readChatImageFile(hotelId, filename) {
  const filePath = hotelImagePath(hotelId, filename)
  if (!filePath) return null
  try {
    const buffer = await fs.readFile(filePath)
    const ext    = path.extname(filename).slice(1).toLowerCase()
    return { buffer, ext }
  } catch {
    return null
  }
}

async function expireOldChatImages(pool) {
  const hours  = getChatImageRetentionHours()
  const result = await pool.query(
    `SELECT id, hotel_id, image_url FROM chat_messages
     WHERE image_url IS NOT NULL
       AND created_at < NOW() - ($1::text || ' hours')::interval`,
    [String(hours)]
  )
  if (!result.rows.length) return 0
  await Promise.all(result.rows.map(r => deleteChatImageFile(r.hotel_id, r.image_url)))
  await pool.query(
    `UPDATE chat_messages SET image_url = NULL WHERE id = ANY($1::uuid[])`,
    [result.rows.map(r => r.id)]
  )
  return result.rows.length
}

module.exports = {
  MIME_EXT, parseBase64Image,
  saveChatImage, deleteChatImageFile, readChatImageFile,
  expireOldChatImages, getChatImageRetentionHours, getChatImageCacheMaxAge,
}
