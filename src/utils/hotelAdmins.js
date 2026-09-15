function normalizeAdminPhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim()
}

const {
  validateLoginId,
  validatePassword,
  hashPassword,
} = require('./passwordAuth')

function shapeHotelAdmin(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    login: row.login_id || (row.provider === 'phone' ? row.provider_id : (row.provider || '')),
    is_super_admin: Boolean(row.is_super_admin),
    created_at: row.created_at,
  }
}

async function isSuperAdminUser(client, userId) {
  const result = await client.query(
    `SELECT is_super_admin FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  )
  return Boolean(result.rows[0]?.is_super_admin)
}

async function userManagesHotel(client, userId, hotelId) {
  if (await isSuperAdminUser(client, userId)) return true
  const result = await client.query(
    `SELECT 1 FROM hotel_admins WHERE hotel_id = $1 AND user_id = $2 LIMIT 1`,
    [hotelId, userId]
  )
  return Boolean(result.rows[0])
}

async function assertManagesHotel(client, userId, hotelId) {
  if (await userManagesHotel(client, userId, hotelId)) return
  throw Object.assign(new Error('เฉพาะแอดมินสาขานี้'), { status: 403 })
}

async function listHotelAdmins(client, hotelId) {
  const result = await client.query(
    `SELECT u.id, u.name, u.provider, u.provider_id, u.login_id, u.is_super_admin, u.created_at
       FROM hotel_admins ha
       JOIN users u ON u.id = ha.user_id
      WHERE ha.hotel_id = $1
      ORDER BY u.created_at ASC`,
    [hotelId]
  )
  return result.rows.map(shapeHotelAdmin)
}

async function addHotelAdmin(client, { hotelId, name, phone, login_id, password }) {
  const cleanName = String(name || '').trim()
  const idSource = login_id || phone
  const idCheck = validateLoginId(idSource)
  if (!cleanName) {
    throw Object.assign(new Error('กรุณากรอกชื่อแอดมิน'), { status: 400 })
  }
  if (!idCheck.ok) {
    throw Object.assign(new Error(idCheck.error || 'กรุณากรอกไอดี'), { status: 400 })
  }
  const pwCheck = validatePassword(password || phone || idCheck.loginId)
  if (!pwCheck.ok) {
    throw Object.assign(new Error(pwCheck.error), { status: 400 })
  }

  let user
  const byLogin = await client.query(
    `SELECT * FROM users WHERE lower(trim(login_id)) = lower(trim($1)) LIMIT 1`,
    [idCheck.loginId]
  )
  if (byLogin.rows[0]) {
    user = byLogin.rows[0]
  } else {
    const byProvider = await client.query(
      `SELECT * FROM users WHERE provider = 'phone' AND provider_id = $1 LIMIT 1`,
      [idCheck.loginId]
    )
    if (byProvider.rows[0]) {
      user = byProvider.rows[0]
    } else {
      const created = await client.query(
        `INSERT INTO users (name, email, provider, provider_id, login_id, password_hash)
         VALUES ($1, $2, 'phone', $3, $3, $4)
         RETURNING *`,
        [cleanName, `${idCheck.loginId}@phone.local`, idCheck.loginId, hashPassword(pwCheck.password)]
      )
      user = created.rows[0]
    }
  }

  if (!user.login_id || !user.password_hash) {
    await client.query(
      `UPDATE users
          SET login_id = COALESCE(NULLIF(trim(login_id), ''), $1),
              password_hash = COALESCE(password_hash, $2),
              name = COALESCE(NULLIF(trim(name), ''), $3)
        WHERE id = $4`,
      [idCheck.loginId, hashPassword(pwCheck.password), cleanName, user.id]
    )
    user = (await client.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0]
  }

  await client.query(`UPDATE users SET is_admin = true WHERE id = $1`, [user.id])
  const inserted = await client.query(
    `INSERT INTO hotel_admins (hotel_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (hotel_id, user_id) DO NOTHING
     RETURNING user_id`,
    [hotelId, user.id]
  )
  if (!inserted.rows[0]) {
    throw Object.assign(new Error('ผู้ใช้นี้เป็นแอดมินสาขานี้อยู่แล้ว'), { status: 409 })
  }

  return shapeHotelAdmin({
    ...user,
    is_admin: true,
    provider: user.provider || 'phone',
    provider_id: user.provider_id || idCheck.loginId,
    login_id: user.login_id || idCheck.loginId,
  })
}

async function removeHotelAdmin(client, { hotelId, userId, actorIsSuperAdmin }) {
  const target = await client.query(
    `SELECT id, is_super_admin FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  )
  if (!target.rows[0]) {
    throw Object.assign(new Error('ไม่พบผู้ใช้'), { status: 404 })
  }
  if (target.rows[0].is_super_admin && !actorIsSuperAdmin) {
    throw Object.assign(new Error('ไม่สามารถถอดแอดมินแพลตฟอร์มได้'), { status: 403 })
  }

  const count = await client.query(
    `SELECT COUNT(*)::int AS n FROM hotel_admins WHERE hotel_id = $1`,
    [hotelId]
  )
  if (Number(count.rows[0]?.n || 0) <= 1) {
    throw Object.assign(new Error('ต้องมีแอดมินอย่างน้อย 1 คน'), { status: 400 })
  }

  const deleted = await client.query(
    `DELETE FROM hotel_admins WHERE hotel_id = $1 AND user_id = $2 RETURNING user_id`,
    [hotelId, userId]
  )
  if (!deleted.rows[0]) {
    throw Object.assign(new Error('ไม่พบแอดมินในสาขานี้'), { status: 404 })
  }
  return { success: true }
}

module.exports = {
  normalizeAdminPhone,
  shapeHotelAdmin,
  isSuperAdminUser,
  userManagesHotel,
  assertManagesHotel,
  listHotelAdmins,
  addHotelAdmin,
  removeHotelAdmin,
}
