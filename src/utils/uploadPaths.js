const fs = require('fs').promises
const path = require('path')

const DEFAULT_UPLOAD_ROOT = path.join(__dirname, '../../uploads')

function getUploadRoot() {
  const configured = String(process.env.UPLOAD_ROOT || '').trim()
  return configured ? path.resolve(configured) : DEFAULT_UPLOAD_ROOT
}

function getUiUploadRoot() {
  return path.join(getUploadRoot(), 'ui')
}

function getChatUploadRoot() {
  return path.join(getUploadRoot(), 'chat')
}

function getReviewUploadRoot() {
  return path.join(getUploadRoot(), 'reviews')
}

function getRoomTypeUploadRoot() {
  return path.join(getUploadRoot(), 'room-types')
}

async function ensureUploadDirs() {
  await fs.mkdir(getUiUploadRoot(), { recursive: true })
  await fs.mkdir(getChatUploadRoot(), { recursive: true })
  await fs.mkdir(getReviewUploadRoot(), { recursive: true })
  await fs.mkdir(getRoomTypeUploadRoot(), { recursive: true })
  await fs.mkdir(path.join(getUploadRoot(), 'renewal'), { recursive: true })
  await fs.mkdir(path.join(getUploadRoot(), 'booking-slips'), { recursive: true })
}

// Without a Render Persistent Disk mounted at UPLOAD_ROOT the folder is wiped on
// every deploy. A marker that survives restarts is the only way to tell the two
// setups apart from the outside, so record one and expose it on /health.
const MARKER_FILE = '.storage-marker.json'
let storageMarker = { persistent: null, firstSeenAt: null, bootCount: 0 }

async function recordStorageMarker() {
  const markerPath = path.join(getUploadRoot(), MARKER_FILE)
  let previous = null
  try {
    previous = JSON.parse(await fs.readFile(markerPath, 'utf8'))
  } catch {
    previous = null
  }

  const bootCount = Number(previous?.bootCount || 0) + 1
  const firstSeenAt = previous?.firstSeenAt || new Date().toISOString()
  storageMarker = {
    persistent: bootCount > 1,
    firstSeenAt,
    bootCount,
  }

  try {
    await fs.writeFile(
      markerPath,
      JSON.stringify({ firstSeenAt, bootCount, lastBootAt: new Date().toISOString() }, null, 2)
    )
  } catch {
    /* read-only or missing disk — /health still reports what we learned */
  }
  return storageMarker
}

function getStorageMarker() {
  return storageMarker
}

module.exports = {
  getUploadRoot,
  getUiUploadRoot,
  getChatUploadRoot,
  getReviewUploadRoot,
  getRoomTypeUploadRoot,
  ensureUploadDirs,
  recordStorageMarker,
  getStorageMarker,
}
