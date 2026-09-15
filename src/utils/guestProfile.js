const GUEST_PROFILE_FIELDS = [
  'guest_title',
  'guest_first_name',
  'guest_last_name',
  'guest_sex',
  'guest_nation',
  'guest_national_id',
  'guest_passport',
  'guest_birthday',
  'guest_phone',
  'guest_car_no',
  'guest_address1',
  'guest_address2',
  'guest_address3',
  'guest_special_requests',
]

const GUEST_SEX = new Set(['male', 'female', ''])

function clip(value, max) {
  const s = String(value ?? '').trim()
  if (!s) return null
  return s.slice(0, max)
}

function normalizeGuestBirthday(value) {
  const day = String(value || '').trim().slice(0, 10)
  if (!day) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  return day
}

function normalizeGuestSex(value) {
  const sex = String(value || '').trim().toLowerCase()
  if (!sex) return null
  if (sex !== 'male' && sex !== 'female') return undefined
  return sex
}

function pickGuestProfilePatch(body) {
  const patch = {}
  for (const key of GUEST_PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    if (key === 'guest_birthday') {
      const day = normalizeGuestBirthday(body[key])
      if (day === undefined) {
        const err = new Error('วันเกิดไม่ถูกต้อง')
        err.status = 400
        throw err
      }
      patch[key] = day
      continue
    }
    if (key === 'guest_sex') {
      const sex = normalizeGuestSex(body[key])
      if (sex === undefined) {
        const err = new Error('เพศไม่ถูกต้อง')
        err.status = 400
        throw err
      }
      patch[key] = sex
      continue
    }
    if (key === 'guest_phone') {
      patch[key] = String(body[key] || '').replace(/[^\d+]/g, '').trim() || null
      continue
    }
    if (key === 'guest_national_id') {
      patch[key] = clip(body[key], 16)
      continue
    }
    if (key === 'guest_passport') {
      patch[key] = clip(body[key], 30)
      continue
    }
    if (key === 'guest_car_no') {
      patch[key] = clip(body[key], 16)
      continue
    }
    if (key === 'guest_address1' || key === 'guest_address2' || key === 'guest_address3') {
      patch[key] = clip(body[key], 60)
      continue
    }
    if (key === 'guest_special_requests') {
      patch[key] = clip(body[key], 500)
      continue
    }
    if (key === 'guest_nation') {
      patch[key] = clip(body[key], 8)
      continue
    }
    if (key === 'guest_title') {
      patch[key] = clip(body[key], 16)
      continue
    }
    patch[key] = clip(body[key], 60)
  }
  return patch
}

function displayNameFromGuestPatch(guest, fallbackName) {
  const first = String(guest.guest_first_name || '').trim()
  const last = String(guest.guest_last_name || '').trim()
  const title = String(guest.guest_title || '').trim()
  if (!first && !last) return null
  const full = [title, first, last].filter(Boolean).join(' ').trim()
  return full || fallbackName || null
}

function normalizeComparable(key, value) {
  if (key === 'guest_birthday') {
    const day = String(value || '').trim().slice(0, 10)
    return day || ''
  }
  if (key === 'guest_sex') {
    return String(value || '').trim().toLowerCase()
  }
  if (key === 'guest_phone') {
    return String(value || '').replace(/[^\d+]/g, '').trim()
  }
  if (key === 'email') {
    return String(value || '').trim().toLowerCase()
  }
  return String(value ?? '').trim()
}

/**
 * สร้าง patch อัปเดตโปรไฟล์จากฟอร์มจอง:
 * - ค่าว่างจากฟอร์ม → ไม่ทับของเดิม
 * - ค่าเดิมเหมือนกัน → ไม่แตะ
 * - ไม่มีค่าเดิม หรือต่างจากเดิม → อัปเดต
 */
function buildGuestProfileDiffFromBooking(currentUser = {}, bookingBody = {}) {
  const incoming = {
    guest_title: bookingBody.guest_title,
    guest_first_name: bookingBody.guest_first_name,
    guest_last_name: bookingBody.guest_last_name,
    guest_sex: bookingBody.guest_sex,
    guest_nation: bookingBody.guest_nation,
    guest_national_id: bookingBody.guest_national_id,
    guest_passport: bookingBody.guest_passport,
    guest_birthday: bookingBody.guest_birthday,
    guest_phone: bookingBody.guest_phone,
    guest_car_no: bookingBody.guest_car_no,
    guest_address1: bookingBody.guest_address1,
    guest_address2: bookingBody.guest_address2,
    guest_address3: bookingBody.guest_address3,
    guest_special_requests: bookingBody.guest_special_requests ?? bookingBody.special_requests,
  }

  if (incoming.guest_birthday != null && normalizeGuestBirthday(incoming.guest_birthday) === undefined) {
    delete incoming.guest_birthday
  }
  if (incoming.guest_sex != null && normalizeGuestSex(incoming.guest_sex) === undefined) {
    delete incoming.guest_sex
  }

  const patch = pickGuestProfilePatch(incoming)

  const diff = {}
  for (const [key, nextVal] of Object.entries(patch)) {
    if (nextVal == null || nextVal === '') continue
    const curNorm = normalizeComparable(key, currentUser[key])
    const nextNorm = normalizeComparable(key, nextVal)
    if (!nextNorm) continue
    if (curNorm === nextNorm) continue
    diff[key] = nextVal
  }

  const emailRaw = String(bookingBody.guest_email || bookingBody.email || '').trim()
  if (emailRaw && !emailRaw.endsWith('@phone.local')) {
    const curEmail = normalizeComparable('email', currentUser.email)
    const nextEmail = normalizeComparable('email', emailRaw)
    if (nextEmail && curEmail !== nextEmail) {
      diff.email = emailRaw.slice(0, 120)
    }
  }

  const merged = { ...currentUser, ...diff }
  const derivedName = displayNameFromGuestPatch(merged, currentUser.name)
  if (derivedName && normalizeComparable('name', currentUser.name) !== normalizeComparable('name', derivedName)) {
    diff.name = derivedName
  }

  return diff
}

async function applyGuestProfileDiff(client, userId, diff) {
  const entries = Object.entries(diff || {})
  if (!entries.length) return null
  const fields = []
  const params = []
  for (const [key, value] of entries) {
    params.push(value)
    fields.push(`${key} = $${params.length}`)
  }
  params.push(userId)
  const result = await client.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params
  )
  return result.rows[0] || null
}

module.exports = {
  GUEST_PROFILE_FIELDS,
  GUEST_SEX,
  pickGuestProfilePatch,
  displayNameFromGuestPatch,
  buildGuestProfileDiffFromBooking,
  applyGuestProfileDiff,
}
