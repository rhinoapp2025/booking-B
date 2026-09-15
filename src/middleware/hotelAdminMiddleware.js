const { getPool } = require('../db/pool')

/**
 * Verifies that req.user is an admin of req.hotel.
 * Must be used AFTER authMiddleware and resolveHotel.
 */
async function hotelAdminMiddleware(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
  if (!req.hotel) return res.status(400).json({ error: 'Hotel context missing' })

  if (req.user.is_super_admin) return next()

  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT 1 FROM hotel_admins WHERE hotel_id = $1 AND user_id = $2 LIMIT 1`,
      [req.hotel.id, req.user.id]
    )
    if (!result.rows[0]) return res.status(403).json({ error: 'Forbidden: hotel admin required' })
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = hotelAdminMiddleware
