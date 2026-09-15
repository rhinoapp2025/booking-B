const router   = require('express').Router()
const passport = require('passport')
const { signToken } = require('../config/passport')
const auth     = require('../middleware/authMiddleware')
const { getPool } = require('../db/pool')
const {
  hotelSlugFromRequest,
  resolveHotelIdBySlug,
  getUserHotelPoints,
} = require('../utils/userHotelPoints')
const {
  pickGuestProfilePatch,
  displayNameFromGuestPatch,
} = require('../utils/guestProfile')
const {
  validateLoginId,
  validatePassword,
  hashPassword,
  verifyPassword,
} = require('../utils/passwordAuth')

const USER_PUBLIC_COLS_TABLE = `id, name, email, avatar_url, provider, provider_id,
  is_admin, is_super_admin, created_at, login_id,
  guest_title, guest_first_name, guest_last_name, guest_sex, guest_nation,
  guest_national_id, guest_passport, guest_birthday, guest_phone, guest_car_no,
  guest_address1, guest_address2, guest_address3, guest_special_requests`

function formatUserRow(row) {
  if (!row) return row
  const user = { ...row }
  delete user.password_hash
  if (user.guest_birthday) user.guest_birthday = String(user.guest_birthday).slice(0, 10)
  user.has_password = Boolean(user.has_password)
  user.can_edit_credentials = user.provider === 'phone' || Boolean(user.login_id)
  user.login_id = user.login_id || (user.provider === 'phone' ? user.provider_id : null) || null
  if (user.provider === 'phone') user.phone = user.provider_id
  else user.phone = user.guest_phone || null
  return user
}

const providerEnv = {
  google:   ['GOOGLE_CLIENT_ID',   'GOOGLE_CLIENT_SECRET',   'GOOGLE_CALLBACK_URL'],
  facebook: ['FACEBOOK_APP_ID',    'FACEBOOK_APP_SECRET',    'FACEBOOK_CALLBACK_URL'],
  line:     ['LINE_CLIENT_ID',     'LINE_CLIENT_SECRET',     'LINE_CALLBACK_URL'],
}

function isProviderEnabled(provider) {
  return (providerEnv[provider] || []).every(k => Boolean(process.env[k]))
}

function requireProvider(provider) {
  return (req, res, next) => {
    if (!isProviderEnabled(provider)) {
      return res.status(503).json({ error: `OAuth provider '${provider}' is not configured` })
    }
    next()
  }
}

function getFrontendBase() {
  return String(process.env.FRONTEND_URL || 'http://localhost:5174').split(',')[0].trim()
}

function redirectWithToken(res, user, hotelSlug = 'default') {
  const token = signToken(user)
  const slug  = String(hotelSlug || 'default').trim().toLowerCase() || 'default'
  res.redirect(`${getFrontendBase()}/${slug}/auth/callback?token=${token}`)
}

function pickHotelSlug(req) {
  const raw = req.query?.state || req.query?.hotel || ''
  const slug = String(raw).trim().toLowerCase()
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : 'default'
}

async function findUserByLoginId(pool, loginId) {
  const found = await pool.query(
    `SELECT * FROM users WHERE lower(trim(login_id)) = lower(trim($1)) LIMIT 1`,
    [loginId]
  )
  if (found.rows[0]) return found.rows[0]
  // บัญชีเก่าที่ยังชี้ provider_id เป็นเบอร์
  const legacy = await pool.query(
    `SELECT * FROM users
      WHERE provider = 'phone' AND provider_id = $1
      LIMIT 1`,
    [loginId]
  )
  return legacy.rows[0] || null
}

async function loginWithCredentials(loginIdRaw, passwordRaw) {
  const idCheck = validateLoginId(loginIdRaw)
  if (!idCheck.ok) {
    const err = new Error(idCheck.error)
    err.status = 400
    throw err
  }
  const pwCheck = validatePassword(passwordRaw)
  if (!pwCheck.ok) {
    const err = new Error(pwCheck.error)
    err.status = 400
    throw err
  }

  const pool = getPool()
  let user = await findUserByLoginId(pool, idCheck.loginId)

  if (!user) {
    const created = await pool.query(
      `INSERT INTO users (name, email, avatar_url, provider, provider_id, login_id, password_hash)
       VALUES ($1, $2, NULL, 'phone', $3, $3, $4)
       RETURNING *`,
      [
        idCheck.loginId,
        `${idCheck.loginId}@phone.local`,
        idCheck.loginId,
        hashPassword(pwCheck.password),
      ]
    )
    return created.rows[0]
  }

  if (user.password_hash) {
    if (!verifyPassword(pwCheck.password, user.password_hash)) {
      const err = new Error('ไอดีหรือรหัสผ่านไม่ถูกต้อง')
      err.status = 401
      throw err
    }
  } else if (
    pwCheck.password === user.provider_id
    || pwCheck.password === user.login_id
    || pwCheck.password === String(user.name || '').trim()
  ) {
    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              login_id = COALESCE(NULLIF(trim(login_id), ''), $2)
        WHERE id = $3`,
      [hashPassword(pwCheck.password), idCheck.loginId, user.id]
    )
    user = (await pool.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0]
  } else {
    const err = new Error('ไอดีหรือรหัสผ่านไม่ถูกต้อง')
    err.status = 401
    throw err
  }

  if (!user.login_id) {
    await pool.query(`UPDATE users SET login_id = $1 WHERE id = $2`, [idCheck.loginId, user.id])
    user.login_id = idCheck.loginId
  }

  return user
}

// ── login (ไอดี + รหัสผ่าน) ───────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const user = await loginWithCredentials(
      req.body?.login_id || req.body?.username || req.body?.phone,
      req.body?.password
    )
    res.json({ token: signToken(user) })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'ไอดีนี้มีบัญชีแล้ว' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

// alias เดิม — รับ login_id/password หรือ name+phone (name=ไอดี, phone=รหัส) เพื่อไม่พัง client เก่า
router.post('/phone-login', async (req, res) => {
  try {
    const hasCreds = req.body?.login_id || req.body?.password || req.body?.username
    const loginId = hasCreds
      ? (req.body.login_id || req.body.username || req.body.phone)
      : (req.body?.name || req.body?.phone)
    const password = hasCreds
      ? req.body.password
      : (req.body?.phone || req.body?.password)
    const user = await loginWithCredentials(loginId, password)
    res.json({ token: signToken(user) })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'ไอดีนี้มีบัญชีแล้ว' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── OAuth ─────────────────────────────────────────────────────────────────────

router.get('/google', requireProvider('google'),
  passport.authenticate('google', { scope: ['profile', 'email'], session: false }))
router.get('/google/callback', requireProvider('google'),
  passport.authenticate('google', { failureRedirect: `${getFrontendBase()}/default/login`, session: false }),
  (req, res) => redirectWithToken(res, req.user, pickHotelSlug(req)))

router.get('/facebook', requireProvider('facebook'),
  passport.authenticate('facebook', { scope: ['email'], session: false }))
router.get('/facebook/callback', requireProvider('facebook'),
  passport.authenticate('facebook', { failureRedirect: `${getFrontendBase()}/default/login`, session: false }),
  (req, res) => redirectWithToken(res, req.user, pickHotelSlug(req)))

router.get('/line', requireProvider('line'),
  passport.authenticate('line', { session: false }))
router.get('/line/callback', requireProvider('line'),
  passport.authenticate('line', { failureRedirect: `${getFrontendBase()}/default/login`, session: false }),
  (req, res) => redirectWithToken(res, req.user, pickHotelSlug(req)))

// ── /me ───────────────────────────────────────────────────────────────────────

router.get('/me', auth, async (req, res) => {
  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.provider, u.provider_id,
              u.is_admin, u.is_super_admin, u.created_at, u.login_id,
              u.guest_title, u.guest_first_name, u.guest_last_name, u.guest_sex, u.guest_nation,
              u.guest_national_id, u.guest_passport, u.guest_birthday, u.guest_phone, u.guest_car_no,
              u.guest_address1, u.guest_address2, u.guest_address3, u.guest_special_requests,
              (u.password_hash IS NOT NULL AND trim(u.password_hash) <> '') AS has_password,
              COUNT(b.id)::int  AS total_bookings,
              SUM(CASE WHEN b.status = 'checked_out' THEN 1 ELSE 0 END)::int AS completed_bookings,
              SUM(CASE WHEN b.status = 'cancelled'   THEN 1 ELSE 0 END)::int AS cancelled_bookings
       FROM users u
       LEFT JOIN bookings b ON b.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'ไม่พบผู้ใช้' })
    const user = formatUserRow(result.rows[0])

    const pointsSlug = hotelSlugFromRequest(req)
    const pointsHotelId = pointsSlug ? await resolveHotelIdBySlug(pool, pointsSlug) : null
    user.total_points = pointsHotelId
      ? await getUserHotelPoints(pool, user.id, pointsHotelId)
      : 0
    user.points_hotel_slug = pointsHotelId ? pointsSlug : null

    let hotelInfo = {
      is_admin: Boolean(user.is_admin),
      hotel_slug: null,
      hotel_slugs: [],
      is_super_admin: Boolean(user.is_super_admin),
    }
    if (user.is_admin) {
      const ha = await pool.query(
        `SELECT h.slug FROM hotel_admins ha JOIN hotels h ON h.id = ha.hotel_id WHERE ha.user_id = $1 ORDER BY h.name`,
        [user.id]
      )
      hotelInfo.hotel_slugs = ha.rows.map((row) => row.slug)
      hotelInfo.hotel_slug = hotelInfo.hotel_slugs[0] || null
    }

    res.json({ ...user, ...hotelInfo, token: signToken(user) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── update credentials (ไอดี / รหัสผ่าน) ──────────────────────────────────────

router.patch('/credentials', auth, async (req, res) => {
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k)
  if (!has('login_id') && !has('password')) {
    return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' })
  }

  try {
    const pool = getPool()
    const current = (await pool.query(
      `SELECT id, name, provider, provider_id, login_id, password_hash, email
         FROM users WHERE id = $1`,
      [req.user.id]
    )).rows[0]
    if (!current) return res.status(404).json({ error: 'ไม่พบผู้ใช้' })
    if (current.provider !== 'phone' && !current.login_id) {
      return res.status(400).json({ error: 'บัญชีนี้เข้าด้วยโซเชียล ไม่สามารถตั้งไอดี/รหัสได้' })
    }

    if (current.password_hash) {
      const currentPw = String(req.body?.current_password || '')
      if (!currentPw || !verifyPassword(currentPw, current.password_hash)) {
        return res.status(401).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' })
      }
    }

    const fields = []
    const params = []
    let nextLoginId = current.login_id || current.provider_id

    if (has('login_id')) {
      const idCheck = validateLoginId(req.body.login_id)
      if (!idCheck.ok) return res.status(400).json({ error: idCheck.error })
      const dup = await pool.query(
        `SELECT id FROM users
          WHERE lower(trim(login_id)) = lower(trim($1)) AND id != $2
          LIMIT 1`,
        [idCheck.loginId, current.id]
      )
      if (dup.rows[0]) return res.status(409).json({ error: 'ไอดีนี้ถูกใช้แล้ว' })
      nextLoginId = idCheck.loginId
      params.push(idCheck.loginId)
      fields.push(`login_id = $${params.length}`)
      params.push(idCheck.loginId)
      fields.push(`provider_id = $${params.length}`)
      if (String(current.email || '').endsWith('@phone.local')) {
        params.push(`${idCheck.loginId}@phone.local`)
        fields.push(`email = $${params.length}`)
      }
    }

    if (has('password')) {
      const pwCheck = validatePassword(req.body.password)
      if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })
      const confirm = String(req.body?.password_confirm ?? req.body?.confirm_password ?? '')
      if (confirm && confirm !== pwCheck.password) {
        return res.status(400).json({ error: 'ยืนยันรหัสผ่านไม่ตรงกัน' })
      }
      params.push(hashPassword(pwCheck.password))
      fields.push(`password_hash = $${params.length}`)
    }

    if (!fields.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' })

    params.push(req.user.id)
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}
       RETURNING ${USER_PUBLIC_COLS_TABLE},
         (password_hash IS NOT NULL AND trim(password_hash) <> '') AS has_password`,
      params
    )
    const user = formatUserRow(result.rows[0])
    const pointsSlug = hotelSlugFromRequest(req)
    const pointsHotelId = pointsSlug ? await resolveHotelIdBySlug(pool, pointsSlug) : null
    user.total_points = pointsHotelId
      ? await getUserHotelPoints(pool, user.id, pointsHotelId)
      : 0
    res.json({ success: true, message: 'บันทึกไอดี/รหัสผ่านแล้ว', user, login_id: nextLoginId })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'ไอดีนี้ถูกใช้แล้ว' })
    res.status(500).json({ error: err.message })
  }
})

// ── update profile ────────────────────────────────────────────────────────────

router.patch('/profile', auth, async (req, res) => {
  const has = k => Object.prototype.hasOwnProperty.call(req.body, k)
  let guestPatch
  try {
    guestPatch = pickGuestProfilePatch(req.body || {})
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  const hasGuest = Object.keys(guestPatch).length > 0
  const hasEmail = has('email')
  if (!has('name') && !hasGuest && !hasEmail) {
    return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' })
  }

  try {
    const pool   = getPool()
    const current = (await pool.query(
      `SELECT ${USER_PUBLIC_COLS_TABLE} FROM users WHERE id = $1`,
      [req.user.id]
    )).rows[0]
    if (!current) return res.status(404).json({ error: 'ไม่พบผู้ใช้' })

    const fields = []
    const params = []

    for (const [key, value] of Object.entries(guestPatch)) {
      params.push(value)
      fields.push(`${key} = $${params.length}`)
    }

    if (hasEmail) {
      const email = String(req.body.email || '').trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'อีเมลไม่ถูกต้อง' })
      }
      if (!(current.provider === 'phone' && !email && String(current.email || '').endsWith('@phone.local'))) {
        params.push(email || null)
        fields.push(`email = $${params.length}`)
      }
    }

    const mergedGuest = { ...current, ...guestPatch }
    const derivedName = displayNameFromGuestPatch(mergedGuest, current.name)
    if (has('name')) {
      const name = String(req.body.name || '').trim()
      if (!name) return res.status(400).json({ error: 'กรุณาระบุชื่อ' })
      params.push(name); fields.push(`name = $${params.length}`)
    } else if (derivedName && hasGuest) {
      params.push(derivedName); fields.push(`name = $${params.length}`)
    }

    if (!fields.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' })

    params.push(req.user.id)
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}
       RETURNING ${USER_PUBLIC_COLS_TABLE},
         (password_hash IS NOT NULL AND trim(password_hash) <> '') AS has_password`,
      params
    )
    const user = formatUserRow(result.rows[0])
    const pointsSlug = hotelSlugFromRequest(req)
    const pointsHotelId = pointsSlug ? await resolveHotelIdBySlug(pool, pointsSlug) : null
    user.total_points = pointsHotelId
      ? await getUserHotelPoints(pool, user.id, pointsHotelId)
      : 0
    res.json({ success: true, message: 'บันทึกข้อมูลแล้ว', user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
