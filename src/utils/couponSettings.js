const { getHotelSettings, setHotelSettings } = require('./hotelSettings')
const { isHotelFeatureEnabled } = require('./hotelFeatureFlags')
const { addUserHotelPoints } = require('./userHotelPoints')

const DEFAULT_DISCOUNT          = 10
const DEFAULT_REQUIRED_POINTS   = 100
const DEFAULT_COMPLETION_POINTS = 5

async function getCouponSettings(poolOrClient, hotelId) {
  const map = await getHotelSettings(poolOrClient, hotelId, [
    'coupon_discount_percent',
    'coupon_required_points',
    'coupon_completion_points',
  ])
  let discountPercent    = Number(map.coupon_discount_percent)
  let requiredPoints     = Number(map.coupon_required_points)
  let completionPoints   = Number(map.coupon_completion_points)
  if (!Number.isInteger(discountPercent)  || discountPercent < 1 || discountPercent > 100) discountPercent  = DEFAULT_DISCOUNT
  if (!Number.isInteger(requiredPoints)   || requiredPoints < 1)                           requiredPoints   = DEFAULT_REQUIRED_POINTS
  if (!Number.isInteger(completionPoints) || completionPoints < 0)                         completionPoints = DEFAULT_COMPLETION_POINTS
  return { discountPercent, requiredPoints, completionPoints }
}

async function setCouponSettings(poolOrClient, hotelId, { discountPercent, requiredPoints, completionPoints }) {
  const payload = { coupon_discount_percent: discountPercent, coupon_required_points: requiredPoints }
  if (completionPoints != null) payload.coupon_completion_points = completionPoints
  await setHotelSettings(poolOrClient, hotelId, payload)
  return getCouponSettings(poolOrClient, hotelId)
}

async function awardCompletionPoints(client, hotelId, userId, bookingId) {
  if (!hotelId || !userId) return 0
  if (!(await isHotelFeatureEnabled(client, hotelId, 'feat_coupons'))) return 0
  const { completionPoints } = await getCouponSettings(client, hotelId)
  if (completionPoints <= 0) return 0
  if (bookingId) {
    const existing = await client.query(
      `SELECT id FROM point_logs WHERE booking_id = $1 AND note = 'checkout' LIMIT 1`,
      [bookingId]
    )
    if (existing.rows[0]) return 0
  }
  await addUserHotelPoints(client, {
    userId,
    hotelId,
    points: completionPoints,
    bookingId,
    note: 'checkout',
  })
  return completionPoints
}

module.exports = {
  DEFAULT_DISCOUNT, DEFAULT_REQUIRED_POINTS, DEFAULT_COMPLETION_POINTS,
  getCouponSettings, setCouponSettings, awardCompletionPoints,
}
