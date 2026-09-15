const router = require('express').Router()
const auth   = require('../middleware/authMiddleware')
const { getPool } = require('../db/pool')
const {
  parseBase64Image, saveReviewImage, readReviewImageFile, deleteReviewImageFile, MIME_EXT,
} = require('../utils/reviewImages')

const COMMENT_MAX = 100

async function resolveHotelBySlug(pool, slug) {
  const r = await pool.query(
    `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`, [slug]
  )
  return r.rows[0] || null
}

function clipComment(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (text.length > COMMENT_MAX) {
    const err = new Error(`ข้อความรีวิวไม่เกิน ${COMMENT_MAX} ตัวอักษร`)
    err.status = 400
    throw err
  }
  return text
}

// GET /api/reviews/:hotelSlug — รีวิวสาธารณะ
router.get('/:hotelSlug', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `SELECT r.id, r.rating, r.cleanliness_rating, r.service_rating, r.location_rating,
              r.comment, r.images, r.created_at,
              u.name AS guest_name, u.avatar_url
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.hotel_id = $1 AND r.is_visible = true
       ORDER BY r.created_at DESC`,
      [hotel.id]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/reviews/:hotelSlug/summary — คะแนนเฉลี่ย
router.get('/:hotelSlug/summary', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `SELECT
         COUNT(*)::int               AS total,
         ROUND(AVG(rating), 2)       AS avg_rating,
         ROUND(AVG(cleanliness_rating), 2) AS avg_cleanliness,
         ROUND(AVG(service_rating), 2)     AS avg_service,
         ROUND(AVG(location_rating), 2)    AS avg_location
       FROM reviews WHERE hotel_id = $1 AND is_visible = true`,
      [hotel.id]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/reviews/:hotelSlug/images/:filename — รูปในรีวิวที่มองเห็นได้
router.get('/:hotelSlug/images/:filename', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const filename = pathBasename(req.params.filename)
    const owned = await pool.query(
      `SELECT 1 FROM reviews
       WHERE hotel_id = $1 AND is_visible = true
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(images) AS img
           WHERE img = $2
         )
       LIMIT 1`,
      [hotel.id, filename]
    )
    if (!owned.rows[0]) return res.status(404).json({ error: 'Image not found' })

    const file = await readReviewImageFile(hotel.id, filename)
    if (!file) return res.status(404).json({ error: 'Image not found' })
    const mime = Object.entries(MIME_EXT).find(([, ext]) => ext === file.ext)?.[0] || 'application/octet-stream'
    res.set('Content-Type', mime)
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(file.buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

function pathBasename(filename) {
  const safe = String(filename || '').split(/[/\\]/).pop()
  return safe || ''
}

// POST /api/reviews/:hotelSlug — เขียนรีวิว (ต้องมีการจองที่ checked_out แล้ว)
router.post('/:hotelSlug', auth, async (req, res) => {
  let savedFilename = null
  let hotelId = null
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    hotelId = hotel.id

    const {
      booking_id, rating, cleanliness_rating, service_rating, location_rating,
      comment, imageData, imageMime,
    } = req.body
    if (!booking_id || !rating) return res.status(400).json({ error: 'booking_id and rating are required' })
    const stars = Number(rating)
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'rating must be 1-5' })
    }

    let commentText
    try {
      commentText = clipComment(comment)
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message })
    }

    const bookingResult = await pool.query(
      `SELECT id FROM bookings
       WHERE id = $1 AND hotel_id = $2 AND user_id = $3 AND status = 'checked_out'`,
      [booking_id, hotel.id, req.user.id]
    )
    if (!bookingResult.rows[0]) {
      return res.status(403).json({ error: 'ต้องเช็คเอาต์แล้วจึงจะรีวิวได้' })
    }

    const images = []
    if (imageData) {
      const parsed = parseBase64Image(imageData, imageMime)
      if (parsed?.error) return res.status(400).json({ error: parsed.error })
      if (!parsed) return res.status(400).json({ error: 'รูปภาพไม่ถูกต้อง' })
      savedFilename = await saveReviewImage(hotel.id, parsed.buffer, parsed.ext)
      images.push(savedFilename)
    }

    const result = await pool.query(
      `INSERT INTO reviews (
         hotel_id, booking_id, user_id, rating, cleanliness_rating, service_rating, location_rating, comment, images
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING *`,
      [
        hotel.id, booking_id, req.user.id, stars,
        cleanliness_rating || null, service_rating || null, location_rating || null,
        commentText, JSON.stringify(images),
      ]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    if (savedFilename && hotelId) {
      await deleteReviewImageFile(hotelId, savedFilename).catch(() => null)
    }
    if (err.code === '23505') return res.status(409).json({ error: 'คุณรีวิวการจองนี้ไปแล้ว' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

module.exports = router
