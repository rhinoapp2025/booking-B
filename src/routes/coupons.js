const crypto = require('crypto')
const router = require('express').Router()
const auth   = require('../middleware/authMiddleware')
const { getPool, withTransaction } = require('../db/pool')
const { getCouponSettings } = require('../utils/couponSettings')
const { isHotelFeatureEnabled } = require('../utils/hotelFeatureFlags')
const { spendUserHotelPoints, hotelSlugFromRequest } = require('../utils/userHotelPoints')

const COUPON_SELECT = `
  id, coupon_code,
  COALESCE(discount_percent, discount_value)::int AS discount_percent,
  required_points, is_used, used_at, created_at
`

function generateCouponCode(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(length)
  let code = ''
  for (let i = 0; i < length; i++) code += chars[bytes[i] % chars.length]
  return code
}

async function generateUniqueCode(client) {
  for (let i = 0; i < 10; i++) {
    const code = generateCouponCode(10)
    const found = await client.query(`SELECT id FROM coupons WHERE coupon_code = $1 LIMIT 1`, [code])
    if (!found.rows[0]) return code
  }
  throw new Error('ไม่สามารถสร้างคูปองได้ กรุณาลองใหม่')
}

async function resolveHotelBySlug(pool, slug) {
  const r = await pool.query(`SELECT id FROM hotels WHERE slug = $1 AND is_active = true`, [slug])
  return r.rows[0] || null
}

async function listMyCoupons(pool, userId, hotelId) {
  const result = await pool.query(
    `SELECT ${COUPON_SELECT}
       FROM coupons
      WHERE user_id = $1 AND hotel_id = $2
      ORDER BY created_at DESC`,
    [userId, hotelId]
  )
  return result.rows
}

// GET /api/coupons/my — คูปองของโรงแรมจาก X-Hotel-Slug
router.get('/my', auth, async (req, res) => {
  try {
    const slug = hotelSlugFromRequest(req)
    if (!slug) return res.status(400).json({ error: 'กรุณาระบุโรงแรม' })
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, slug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await listMyCoupons(pool, req.user.id, hotel.id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/coupons/:hotelSlug/settings
router.get('/:hotelSlug/settings', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    if (!(await isHotelFeatureEnabled(pool, hotel.id, 'feat_coupons'))) {
      return res.status(403).json({ error: 'คูปองปิดใช้งานสำหรับโรงแรมนี้' })
    }
    const settings = await getCouponSettings(pool, hotel.id)
    res.json({ discount_percent: settings.discountPercent, required_points: settings.requiredPoints, completion_points: settings.completionPoints })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/coupons/:hotelSlug/my — คูปองของผู้ใช้ในโรงแรมนี้
router.get('/:hotelSlug/my', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await listMyCoupons(pool, req.user.id, hotel.id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/coupons/:hotelSlug/redeem — แลกแต้มของโรงแรมนี้เป็นคูปอง
router.post('/:hotelSlug/redeem', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    if (!(await isHotelFeatureEnabled(pool, hotel.id, 'feat_coupons'))) {
      return res.status(403).json({ error: 'คูปองปิดใช้งานสำหรับโรงแรมนี้' })
    }

    const { discountPercent, requiredPoints } = await getCouponSettings(pool, hotel.id)

    const coupon = await withTransaction(async (client) => {
      await spendUserHotelPoints(client, {
        userId: req.user.id,
        hotelId: hotel.id,
        points: requiredPoints,
        note: 'redeem',
      })
      const code = await generateUniqueCode(client)
      const created = await client.query(
        `INSERT INTO coupons (
           user_id, hotel_id, coupon_code,
           discount_type, discount_value, discount_percent, required_points
         )
         VALUES ($1, $2, $3, 'percent', $4, $4, $5)
         RETURNING ${COUPON_SELECT}`,
        [req.user.id, hotel.id, code, discountPercent, requiredPoints]
      )
      return created.rows[0]
    })

    res.status(201).json({ success: true, coupon })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

module.exports = router
