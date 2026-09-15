const admin = require('firebase-admin')
const fs = require('fs')
const path = require('path')

let initAttempted = false

function readServiceAccountRaw() {
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  if (filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath)
    if (!fs.existsSync(resolved)) {
      console.warn(`Push notifications disabled — Firebase service account not found: ${resolved}`)
      return null
    }
    return fs.readFileSync(resolved, 'utf8')
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!raw) return null
  return raw
}

function parseServiceAccount(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch (firstErr) {
    const compact = trimmed.replace(/\r?\n/g, '').replace(/\s+/g, ' ')
    try {
      return JSON.parse(compact)
    } catch {
      console.error('Firebase Admin init failed:', firstErr.message)
      console.error('Hint: use FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json for local dev')
      return null
    }
  }
}

function initFirebaseAdmin() {
  if (admin.apps.length) return true
  if (initAttempted) return false
  initAttempted = true

  const raw = readServiceAccountRaw()
  if (!raw) return false

  const serviceAccount = parseServiceAccount(raw)
  if (!serviceAccount) return false

  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    })
    return true
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message)
    return false
  }
}

function getMessaging() {
  if (!initFirebaseAdmin()) return null
  return admin.messaging()
}

function isFcmConfigured() {
  return initFirebaseAdmin()
}

module.exports = {
  getMessaging,
  isFcmConfigured,
}
