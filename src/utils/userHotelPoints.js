const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseHotelSlug(raw) {
  const slug = String(raw || '').trim().toLowerCase()
  return SLUG_RE.test(slug) ? slug : null
}

function hotelSlugFromRequest(req) {
  return parseHotelSlug(req?.headers?.['x-hotel-slug'] || req?.query?.hotel)
}

async function resolveHotelIdBySlug(client, slug) {
  const parsed = parseHotelSlug(slug)
  if (!parsed) return null
  const result = await client.query(
    `SELECT id FROM hotels WHERE slug = $1 AND is_active = true LIMIT 1`,
    [parsed]
  )
  return result.rows[0]?.id || null
}

async function getUserHotelPoints(client, userId, hotelId) {
  if (!userId || !hotelId) return 0
  const result = await client.query(
    `SELECT points FROM user_hotel_points WHERE user_id = $1 AND hotel_id = $2`,
    [userId, hotelId]
  )
  return Number(result.rows[0]?.points || 0)
}

async function lockWallet(client, userId, hotelId) {
  await client.query(
    `INSERT INTO user_hotel_points (user_id, hotel_id, points)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, hotel_id) DO NOTHING`,
    [userId, hotelId]
  )
  const result = await client.query(
    `SELECT points FROM user_hotel_points WHERE user_id = $1 AND hotel_id = $2 FOR UPDATE`,
    [userId, hotelId]
  )
  return Number(result.rows[0]?.points || 0)
}

async function addUserHotelPoints(client, { userId, hotelId, points, bookingId = null, note = null }) {
  const amount = Number(points)
  if (!userId || !hotelId || !Number.isInteger(amount) || amount === 0) return 0
  await lockWallet(client, userId, hotelId)
  await client.query(
    `UPDATE user_hotel_points
        SET points = points + $1, updated_at = NOW()
      WHERE user_id = $2 AND hotel_id = $3`,
    [amount, userId, hotelId]
  )
  await client.query(
    `INSERT INTO point_logs (user_id, hotel_id, booking_id, points, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hotelId, bookingId, amount, note]
  )
  return amount
}

async function spendUserHotelPoints(client, { userId, hotelId, points, note = 'redeem' }) {
  const cost = Number(points)
  if (!userId || !hotelId || !Number.isInteger(cost) || cost < 1) {
    throw Object.assign(new Error('จำนวนแต้มไม่ถูกต้อง'), { status: 400 })
  }
  const balance = await lockWallet(client, userId, hotelId)
  if (balance < cost) {
    throw Object.assign(new Error(`แต้มไม่พอ (ต้องการ ${cost} แต้ม)`), { status: 400 })
  }
  await client.query(
    `UPDATE user_hotel_points
        SET points = points - $1, updated_at = NOW()
      WHERE user_id = $2 AND hotel_id = $3`,
    [cost, userId, hotelId]
  )
  await client.query(
    `INSERT INTO point_logs (user_id, hotel_id, points, note)
     VALUES ($1, $2, $3, $4)`,
    [userId, hotelId, -cost, note]
  )
  return balance - cost
}

module.exports = {
  parseHotelSlug,
  hotelSlugFromRequest,
  resolveHotelIdBySlug,
  getUserHotelPoints,
  addUserHotelPoints,
  spendUserHotelPoints,
}
