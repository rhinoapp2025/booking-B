const crypto = require('crypto')

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const MIN_PASSWORD_LEN = 4
const MAX_PASSWORD_LEN = 72
const MIN_LOGIN_ID_LEN = 3
const MAX_LOGIN_ID_LEN = 64

function normalizeLoginId(value) {
  return String(value || '').trim()
}

function validateLoginId(raw) {
  const loginId = normalizeLoginId(raw)
  if (loginId.length < MIN_LOGIN_ID_LEN || loginId.length > MAX_LOGIN_ID_LEN) {
    return { ok: false, error: `ไอดีต้องยาว ${MIN_LOGIN_ID_LEN}-${MAX_LOGIN_ID_LEN} ตัวอักษร` }
  }
  if (/\s/.test(loginId)) {
    return { ok: false, error: 'ไอดีห้ามมีช่องว่าง' }
  }
  return { ok: true, loginId }
}

function validatePassword(raw, { required = true } = {}) {
  const password = String(raw ?? '')
  if (!password) {
    if (!required) return { ok: true, password: '' }
    return { ok: false, error: 'กรุณาระบุรหัสผ่าน' }
  }
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    return { ok: false, error: `รหัสผ่านต้องยาว ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} ตัวอักษร` }
  }
  return { ok: true, password }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_OPTS)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, saltHex, hashHex] = parts
  if (!saltHex || !hashHex) return false
  let expected
  let actual
  try {
    expected = Buffer.from(hashHex, 'hex')
    actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTS)
  } catch {
    return false
  }
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

module.exports = {
  MIN_PASSWORD_LEN,
  normalizeLoginId,
  validateLoginId,
  validatePassword,
  hashPassword,
  verifyPassword,
}
