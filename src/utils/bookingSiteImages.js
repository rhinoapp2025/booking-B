const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { getBookingSiteUploadRoot } = require('./uploadPaths')
const { parseBase64Image } = require('./chatImages')

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,79}\.(jpe?g|png|webp|gif|mp4|webm)$/i
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
}
const VIDEO_MIME = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}
const VIDEO_MAX_BYTES = 12 * 1024 * 1024

function parseBase64Media(imageData, imageMime) {
  let b64 = String(imageData || '')
  const match = b64.match(/^data:([^;]+);base64,(.+)$/i)
  const mimeFromData = match ? String(match[1] || '').toLowerCase().trim() : ''
  if (match) b64 = match[2]
  let mime = String(imageMime || mimeFromData || '').toLowerCase().trim()
  const ext = VIDEO_MIME[mime]
  if (!ext) return parseBase64Image(imageData, imageMime)
  let buffer
  try { buffer = Buffer.from(b64, 'base64') } catch { return { error: 'วิดีโอไม่ถูกต้อง' } }
  if (!buffer.length) return { error: 'วิดีโอว่าง' }
  if (buffer.length > VIDEO_MAX_BYTES) return { error: 'วิดีโอใหญ่เกิน 12MB' }
  return { buffer, ext, mime }
}

function isAllowedFolder(folder) {
  return FOLDER_RE.test(String(folder || ''))
}

function isAllowedFilename(filename) {
  const name = path.basename(String(filename || ''))
  return name === filename && FILE_RE.test(name) && !name.startsWith('.')
}

function hotelFolderDir(hotelId, folder) {
  if (!isAllowedFolder(folder)) return null
  return path.join(getBookingSiteUploadRoot(), String(hotelId), String(folder).toLowerCase())
}

function buildImagePath(slug, folder, filename) {
  return `/api/hotels/${encodeURIComponent(slug)}/booking-site/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`
}

async function listFolderImages(hotelId, slug, folder) {
  const dir = hotelFolderDir(hotelId, folder)
  if (!dir) return { error: 'ชื่อโฟลเดอร์ใช้ได้เฉพาะ a-z 0-9 - _' }
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if (err?.code === 'ENOENT') return { files: [] }
    throw err
  }
  const withTime = []
  for (const name of names) {
    if (!isAllowedFilename(name)) continue
    try {
      const stat = await fs.stat(path.join(dir, name))
      withTime.push({ name, t: stat.mtimeMs })
    } catch {
      /* skip unreadable */
    }
  }
  withTime.sort((a, b) => b.t - a.t)
  return {
    files: withTime.map((item) => buildImagePath(slug, String(folder).toLowerCase(), item.name)),
  }
}

async function saveFolderImage(hotelId, slug, folder, buffer, ext) {
  const dir = hotelFolderDir(hotelId, folder)
  if (!dir) return { error: 'ชื่อโฟลเดอร์ใช้ได้เฉพาะ a-z 0-9 - _' }
  await fs.mkdir(dir, { recursive: true })
  const filename = `${crypto.randomBytes(6).toString('hex')}.${ext}`
  await fs.writeFile(path.join(dir, filename), buffer)
  return { url: buildImagePath(slug, String(folder).toLowerCase(), filename) }
}

async function readFolderImage(hotelId, folder, filename) {
  const dir = hotelFolderDir(hotelId, folder)
  if (!dir || !isAllowedFilename(filename)) return null
  try {
    return await fs.readFile(path.join(dir, filename))
  } catch {
    return null
  }
}

function mimeForFilename(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

module.exports = {
  isAllowedFolder,
  isAllowedFilename,
  listFolderImages,
  saveFolderImage,
  readFolderImage,
  mimeForFilename,
  parseBase64Image,
  parseBase64Media,
}
