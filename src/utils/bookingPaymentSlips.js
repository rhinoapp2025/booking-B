const fs     = require('fs').promises
const path   = require('path')
const crypto = require('crypto')
const { getUploadRoot } = require('./uploadPaths')

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
}

const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]))

function bookingSlipDir() {
  return path.join(getUploadRoot(), 'booking-slips')
}

function bookingSlipPath(filename) {
  const safeName = path.basename(String(filename || ''))
  if (!safeName || safeName !== filename || safeName.includes('..')) return null
  return path.join(bookingSlipDir(), safeName)
}

// ── base64 parser ─────────────────────────────────────────────────────────────

function parseBase64Image(imageData, imageMime) {
  const raw = String(imageData || '').trim()
  if (!raw) return { error: 'imageData is required' }
  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/)
  let mime, base64
  if (dataUrlMatch) {
    mime   = dataUrlMatch[1].toLowerCase()
    base64 = dataUrlMatch[2]
  } else {
    mime   = String(imageMime || 'image/jpeg').toLowerCase()
    base64 = raw
  }
  const ext = MIME_EXT[mime]
  if (!ext) return { error: `Unsupported image type: ${mime}` }
  let buffer
  try { buffer = Buffer.from(base64, 'base64') } catch { return { error: 'Invalid base64 data' } }
  if (buffer.length > 5 * 1024 * 1024) return { error: 'Image too large (max 5MB)' }
  return { buffer, ext, mime }
}

// ── file operations ───────────────────────────────────────────────────────────

async function saveBookingPaymentSlip(bookingId, buffer, ext) {
  const dir = bookingSlipDir()
  await fs.mkdir(dir, { recursive: true })
  const filename = `${bookingId}_${crypto.randomUUID()}.${ext}`
  await fs.writeFile(path.join(dir, filename), buffer)
  return filename
}

async function readBookingPaymentSlip(filename) {
  const filePath = bookingSlipPath(filename)
  if (!filePath) return null
  try {
    const buffer = await fs.readFile(filePath)
    const ext    = path.extname(filename).slice(1).toLowerCase()
    return { buffer, ext }
  } catch {
    return null
  }
}

async function deleteBookingPaymentSlip(filename) {
  const filePath = bookingSlipPath(filename)
  if (!filePath) return
  try { await fs.unlink(filePath) } catch { /* ignore */ }
}

async function deletePaymentSlipByBookingId(poolOrClient, bookingId) {
  const result = await poolOrClient.query(
    `SELECT id, slip_filename FROM booking_payment_slips WHERE booking_id = $1 LIMIT 1`,
    [bookingId]
  )
  const row = result.rows[0]
  if (!row) return false
  await deleteBookingPaymentSlip(row.slip_filename)
  await poolOrClient.query(`DELETE FROM booking_payment_slips WHERE id = $1`, [row.id])
  return true
}

module.exports = {
  MIME_EXT, EXT_MIME,
  parseBase64Image,
  saveBookingPaymentSlip, readBookingPaymentSlip,
  deleteBookingPaymentSlip, deletePaymentSlipByBookingId,
  bookingSlipPath,
}
