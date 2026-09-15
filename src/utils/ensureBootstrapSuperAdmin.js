/**
 * สร้างซูเปอร์แอดมินครั้งแรกจาก env (ถ้ายังไม่มีใครเป็นซูเปอร์)
 * SUPER_ADMIN_LOGIN + SUPER_ADMIN_PASSWORD ต้องตั้งคู่กัน
 * ไม่ hardcode รหัสในโค้ด — ใส่เฉพาะใน .env บนเซิร์ฟเวอร์
 */
const { hashPassword, validateLoginId, validatePassword } = require('./passwordAuth')

async function ensureBootstrapSuperAdmin(pool) {
  const loginRaw = process.env.SUPER_ADMIN_LOGIN
  const passwordRaw = process.env.SUPER_ADMIN_PASSWORD
  if (!loginRaw || !passwordRaw) return

  const already = await pool.query(
    `SELECT 1 FROM users WHERE is_super_admin = true LIMIT 1`
  )
  if (already.rows[0]) return

  const idCheck = validateLoginId(loginRaw)
  const pwCheck = validatePassword(passwordRaw)
  if (!idCheck.ok) {
    console.warn(`⚠️  SUPER_ADMIN_LOGIN ไม่ถูกต้อง: ${idCheck.error}`)
    return
  }
  if (!pwCheck.ok) {
    console.warn(`⚠️  SUPER_ADMIN_PASSWORD ไม่ถูกต้อง: ${pwCheck.error}`)
    return
  }

  const name = String(process.env.SUPER_ADMIN_NAME || 'Super Admin').trim() || 'Super Admin'
  const hotelSlug = String(process.env.SUPER_ADMIN_HOTEL || 'default').trim() || 'default'
  const passwordHash = hashPassword(pwCheck.password)

  const hotelRow = await pool.query(
    `SELECT id FROM hotels WHERE slug = $1 LIMIT 1`,
    [hotelSlug]
  )
  const hotelId = hotelRow.rows[0]?.id || null

  const existing = await pool.query(
    `SELECT id FROM users WHERE lower(trim(login_id)) = lower(trim($1)) LIMIT 1`,
    [idCheck.loginId]
  )

  let userId
  if (existing.rows[0]) {
    userId = existing.rows[0].id
    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              name = COALESCE(NULLIF(trim(name), ''), $2),
              is_admin = true,
              is_super_admin = true
        WHERE id = $3`,
      [passwordHash, name, userId]
    )
    console.log(`✅ Bootstrap super admin: อัปเดตไอดี ${idCheck.loginId}`)
  } else {
    const created = await pool.query(
      `INSERT INTO users (name, email, provider, provider_id, login_id, password_hash, is_admin, is_super_admin)
       VALUES ($1, $2, 'phone', $3, $3, $4, true, true)
       RETURNING id`,
      [name, `${idCheck.loginId}@phone.local`, idCheck.loginId, passwordHash]
    )
    userId = created.rows[0].id
    console.log(`✅ Bootstrap super admin: สร้างไอดี ${idCheck.loginId}`)
  }

  if (hotelId) {
    await pool.query(
      `INSERT INTO hotel_admins (hotel_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (hotel_id, user_id) DO NOTHING`,
      [hotelId, userId]
    )
  }
}

module.exports = { ensureBootstrapSuperAdmin }
