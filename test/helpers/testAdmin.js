const path = require('path')

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })

const TEST_ADMIN_NAME = process.env.TEST_ADMIN_NAME || 'E2E Admin'
const TEST_ADMIN_PHONE = process.env.TEST_ADMIN_PHONE || '0890000001'

async function ensureTestAdmin() {
  const { getPool } = require('../../src/db/pool')
  const { signToken } = require('../../src/config/passport')
  const pool = getPool()

  const found = await pool.query(
    `
      SELECT *
      FROM users
      WHERE provider = 'phone'
        AND provider_id = $1
        AND lower(trim(name)) = lower(trim($2))
      LIMIT 1
    `,
    [TEST_ADMIN_PHONE, TEST_ADMIN_NAME]
  )

  let user = found.rows[0]
  if (!user) {
    const created = await pool.query(
      `
        INSERT INTO users (name, email, avatar_url, provider, provider_id, is_admin)
        VALUES ($1, $2, NULL, 'phone', $3, true)
        RETURNING *
      `,
      [TEST_ADMIN_NAME, `${TEST_ADMIN_PHONE}@phone.local`, TEST_ADMIN_PHONE]
    )
    user = created.rows[0]
  } else if (!user.is_admin) {
    await pool.query(`UPDATE users SET is_admin = true WHERE id = $1`, [user.id])
    user = { ...user, is_admin: true }
  }

  const defaultShop = await pool.query(`SELECT id FROM shops WHERE slug = 'default' LIMIT 1`)
  if (defaultShop.rows[0]) {
    await pool.query(
      `
        INSERT INTO shop_admins (shop_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [defaultShop.rows[0].id, user.id]
    )
  }

  return {
    user,
    token: signToken(user),
    shop: process.env.TEST_SHOP_SLUG || 'default',
  }
}

module.exports = {
  TEST_ADMIN_NAME,
  TEST_ADMIN_PHONE,
  ensureTestAdmin,
}
