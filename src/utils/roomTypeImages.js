/**
 * รูปประเภทห้อง — default Unsplash + อัปโหลดเก็บใน uploads/room-types
 */

const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { getUploadRoot } = require('./uploadPaths')
const { parseBase64Image } = require('./chatImages')

const MAX_IMAGES = 5
const VIEW_TYPES = new Set(['garden', 'sea', 'mountain', 'river'])

const IMAGES = {
  suite:    'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80',
  deluxe:   'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&w=1200&q=80',
  superior: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1200&q=80',
  twin:     'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=80',
  standard: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=1200&q=80',
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

function defaultRoomImage(typeName) {
  const n = String(typeName || '').toUpperCase()
  if (n.includes('SUI') || n.includes('SUITE')) return IMAGES.suite
  if (n.includes('TWIN') || n.endsWith('T') || n.includes('DLXT') || n.includes('SUPT')) return IMAGES.twin
  if (n.includes('DLX') || n.includes('DELUXE')) return IMAGES.deluxe
  if (n.includes('SUP') || n.includes('SUPERIOR')) return IMAGES.superior
  return IMAGES.standard
}

function defaultRoomImages(typeName) {
  return [defaultRoomImage(typeName)]
}

function getRoomTypeUploadRoot() {
  return path.join(getUploadRoot(), 'room-types')
}

function roomTypeDir(hotelId, roomTypeId) {
  return path.join(getRoomTypeUploadRoot(), String(hotelId), String(roomTypeId))
}

function publicRoomTypeImagePath(slug, roomTypeId, filename) {
  const safe = path.basename(String(filename || ''))
  if (!safe || safe.includes('..')) return ''
  return `/api/hotels/${encodeURIComponent(slug)}/room-type-images/${encodeURIComponent(roomTypeId)}/${encodeURIComponent(safe)}`
}

function imageFilename(entry) {
  if (!entry) return ''
  if (typeof entry === 'string') {
    if (/^https?:\/\//i.test(entry) || entry.startsWith('/api/')) return entry
    return path.basename(entry)
  }
  return String(entry.filename || entry.url || entry.src || '').trim()
}

function normalizeStoredImages(images) {
  const list = Array.isArray(images) ? images : []
  const out = []
  for (const entry of list) {
    const name = imageFilename(entry)
    if (!name || /^https?:\/\//i.test(name) || name.startsWith('/api/')) continue
    const safe = path.basename(name)
    if (safe && !out.includes(safe)) out.push(safe)
  }
  return out.slice(0, MAX_IMAGES)
}

function resolveRoomTypeImages(images, { slug, roomTypeId, typeName }) {
  const list = Array.isArray(images) ? images : []
  const urls = []
  for (const entry of list) {
    const name = imageFilename(entry)
    if (!name) continue
    if (/^https?:\/\//i.test(name) || name.startsWith('/api/') || name.startsWith('data:')) {
      urls.push(name)
      continue
    }
    const url = publicRoomTypeImagePath(slug, roomTypeId, name)
    if (url) urls.push(url)
  }
  return urls.length ? urls : defaultRoomImages(typeName)
}

function firstRoomImage(images, typeName, opts = {}) {
  const resolved = opts.slug && opts.roomTypeId
    ? resolveRoomTypeImages(images, { ...opts, typeName })
    : (Array.isArray(images) ? images.map(imageFilename).filter(Boolean) : [])
  return resolved[0] || defaultRoomImage(typeName)
}

function normalizeViewType(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!v) return null
  if (v.length > 64) return undefined
  return v
}

async function saveRoomTypeImage(hotelId, roomTypeId, buffer, ext) {
  const dir = roomTypeDir(hotelId, roomTypeId)
  await fs.mkdir(dir, { recursive: true })
  const filename = `${crypto.randomUUID()}.${ext}`
  await fs.writeFile(path.join(dir, filename), buffer)
  return filename
}

async function deleteRoomTypeImageFile(hotelId, roomTypeId, filename) {
  const safe = path.basename(String(filename || ''))
  if (!safe || safe !== filename || safe.includes('..')) return
  try {
    await fs.unlink(path.join(roomTypeDir(hotelId, roomTypeId), safe))
  } catch {
    /* ignore */
  }
}

async function readRoomTypeImageFile(hotelId, roomTypeId, filename) {
  const safe = path.basename(String(filename || ''))
  if (!safe || safe !== filename || safe.includes('..')) return null
  try {
    const buffer = await fs.readFile(path.join(roomTypeDir(hotelId, roomTypeId), safe))
    const ext = path.extname(safe).slice(1).toLowerCase()
    return { buffer, ext, mime: MIME_BY_EXT[ext] || 'application/octet-stream' }
  } catch {
    return null
  }
}

async function deleteAllRoomTypeImages(hotelId, roomTypeId) {
  const dir = roomTypeDir(hotelId, roomTypeId)
  try {
    const names = await fs.readdir(dir)
    await Promise.all(names.map((name) => fs.unlink(path.join(dir, name)).catch(() => null)))
    await fs.rmdir(dir).catch(() => null)
  } catch {
    /* ignore */
  }
}

module.exports = {
  MAX_IMAGES,
  VIEW_TYPES,
  defaultRoomImage,
  defaultRoomImages,
  firstRoomImage,
  resolveRoomTypeImages,
  normalizeStoredImages,
  normalizeViewType,
  publicRoomTypeImagePath,
  parseBase64Image,
  saveRoomTypeImage,
  deleteRoomTypeImageFile,
  readRoomTypeImageFile,
  deleteAllRoomTypeImages,
  getRoomTypeUploadRoot,
}
