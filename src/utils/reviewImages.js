const fs     = require('fs').promises
const path   = require('path')
const crypto = require('crypto')
const { getReviewUploadRoot } = require('./uploadPaths')
const { parseBase64Image, MIME_EXT } = require('./chatImages')

function hotelReviewPath(hotelId, filename) {
  const safeName = path.basename(String(filename || ''))
  if (!safeName || safeName !== filename || safeName.includes('..')) return null
  return path.join(getReviewUploadRoot(), String(hotelId), safeName)
}

async function saveReviewImage(hotelId, buffer, ext) {
  const dir = path.join(getReviewUploadRoot(), String(hotelId))
  await fs.mkdir(dir, { recursive: true })
  const filename = `${crypto.randomUUID()}.${ext}`
  await fs.writeFile(path.join(dir, filename), buffer)
  return filename
}

async function readReviewImageFile(hotelId, filename) {
  const filePath = hotelReviewPath(hotelId, filename)
  if (!filePath) return null
  try {
    const buffer = await fs.readFile(filePath)
    const ext = path.extname(filename).slice(1).toLowerCase()
    return { buffer, ext }
  } catch {
    return null
  }
}

async function deleteReviewImageFile(hotelId, filename) {
  const filePath = hotelReviewPath(hotelId, filename)
  if (!filePath) return
  try { await fs.unlink(filePath) } catch { /* ignore */ }
}

module.exports = {
  MIME_EXT,
  parseBase64Image,
  saveReviewImage,
  readReviewImageFile,
  deleteReviewImageFile,
}
