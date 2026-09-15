/**
 * สร้าง (หรืออัปเดต) แอดมินสำหรับโรงแรม
 *
 * Usage:
 *   node scripts/create-admin.js
 *   node scripts/create-admin.js --name="ชื่อ" --login="admin01" --password="secret" --hotel="default"
 *   node scripts/create-admin.js --name="ชื่อ" --phone="0812345678" --hotel="default"
 *     (phone = ไอดี และรหัสเริ่มต้น ถ้าไม่ส่ง login/password)
 *   node scripts/create-admin.js --super --name="ชื่อ" --login="1518" --password="1599" --hotel="default"
 *     (--super = ตั้ง is_super_admin ด้วย)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { getPool } = require('../src/db/pool')
const { hashPassword, validateLoginId, validatePassword } = require('../src/utils/passwordAuth')
const readline    = require('readline')

function getArg(flag) {
  const found = process.argv.find(a => a.startsWith(`--${flag}=`))
  return found ? found.split('=').slice(1).join('=') : null
}

function hasFlag(flag) {
  return process.argv.includes(`--${flag}`)
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const asSuper = hasFlag('super')

  console.log(asSuper
    ? '\n🔑  สร้างซูเปอร์แอดมิน Hotel Booking System\n'
    : '\n🔑  สร้างแอดมิน Hotel Booking System\n')

  const name      = getArg('name')     || await ask(rl, 'ชื่อแอดมิน       : ')
  const phoneArg  = getArg('phone')
  const loginArg  = getArg('login')    || getArg('login_id') || phoneArg || await ask(rl, 'ไอดีเข้าสู่ระบบ  : ')
  const passArg   = getArg('password') || phoneArg || await ask(rl, 'รหัสผ่าน         : ')
  const hotelSlug = getArg('hotel')    || await ask(rl, 'Hotel slug (default) : ') || 'default'

  rl.close()

  const cleanName  = String(name).trim()
  const idCheck = validateLoginId(loginArg)
  const pwCheck = validatePassword(passArg)

  if (!cleanName) {
    console.error('❌  กรุณาระบุชื่อ')
    process.exit(1)
  }
  if (!idCheck.ok) {
    console.error(`❌  ${idCheck.error}`)
    process.exit(1)
  }
  if (!pwCheck.ok) {
    console.error(`❌  ${pwCheck.error}`)
    process.exit(1)
  }

  const pool = await getPool()

  const hotelRow = await pool.query(
    `SELECT id, name FROM hotels WHERE slug = $1`, [hotelSlug]
  )
  if (!hotelRow.rows[0]) {
    console.error(`❌  ไม่พบโรงแรม slug="${hotelSlug}"`)
    console.log('   โรงแรมที่มีอยู่:')
    const all = await pool.query(`SELECT slug, name FROM hotels ORDER BY name`)
    all.rows.forEach(h => console.log(`   - ${h.slug}  (${h.name})`))
    process.exit(1)
  }
  const hotel = hotelRow.rows[0]

  let user
  const existing = await pool.query(
    `SELECT * FROM users WHERE lower(trim(login_id)) = lower(trim($1)) LIMIT 1`,
    [idCheck.loginId]
  )

  if (existing.rows[0]) {
    user = existing.rows[0]
    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              name = COALESCE(NULLIF(trim(name), ''), $2),
              is_admin = true,
              is_super_admin = CASE WHEN $4 THEN true ELSE is_super_admin END
        WHERE id = $3`,
      [hashPassword(pwCheck.password), cleanName, user.id, asSuper]
    )
    console.log(`\n✅  พบผู้ใช้เดิม: ${user.name || cleanName} (ไอดี ${idCheck.loginId}) — อัปเดตรหัสแล้ว`)
  } else {
    const created = await pool.query(
      `INSERT INTO users (name, email, provider, provider_id, login_id, password_hash, is_admin, is_super_admin)
       VALUES ($1, $2, 'phone', $3, $3, $4, true, $5) RETURNING *`,
      [cleanName, `${idCheck.loginId}@phone.local`, idCheck.loginId, hashPassword(pwCheck.password), asSuper]
    )
    user = created.rows[0]
    console.log(`\n✅  สร้างผู้ใช้ใหม่: ${user.name} (ไอดี ${idCheck.loginId})`)
  }

  await pool.query(`UPDATE users SET is_admin = true WHERE id = $1`, [user.id])
  if (asSuper) {
    await pool.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [user.id])
  }

  await pool.query(
    `INSERT INTO hotel_admins (hotel_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (hotel_id, user_id) DO NOTHING`,
    [hotel.id, user.id]
  )

  console.log(`\n🎉  ตั้งค่า${asSuper ? 'ซูเปอร์' : ''}แอดมินสำเร็จ!`)
  console.log(`   ชื่อ    : ${cleanName}`)
  console.log(`   ไอดี    : ${idCheck.loginId}`)
  console.log(`   บทบาท  : ${asSuper ? 'ซูเปอร์แอดมิน' : 'แอดมินสาขา'}`)
  console.log(`   โรงแรม  : ${hotel.name} (/${hotelSlug})`)
  console.log(`\n   เข้าสู่ระบบด้วยไอดีและรหัสผ่านที่ตั้งไว้\n`)

  process.exit(0)
}

main().catch(err => {
  console.error('❌  Error:', err.message)
  process.exit(1)
})
