const { getPool } = require('../db/pool')

/**
 * Resolve hotel from :hotelSlug param and attach to req.hotel.
 * Returns 404 if not found or not active.
 */
async function resolveHotel(req, res, next) {
  const slug = req.params.hotelSlug || req.params.slug
  if (!slug) return res.status(400).json({ error: 'Hotel slug is required' })
  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT id, slug, name FROM hotels WHERE slug = $1 AND is_active = true`,
      [slug]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    req.hotel = result.rows[0]
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = resolveHotel
