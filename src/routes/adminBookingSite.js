const router = require('express').Router()
const { getPool } = require('../db/pool')
const { getBookingSiteContent, saveBookingSiteContent } = require('../utils/bookingSite')
const { isHotelFeatureEnabled } = require('../utils/hotelFeatureFlags')
const {
  isAllowedFolder,
  listFolderImages,
  saveFolderImage,
  parseBase64Image,
} = require('../utils/bookingSiteImages')

async function loadHotel(slug) {
  const pool = getPool()
  const result = await pool.query(
    `SELECT id, slug, name, address, phone, email FROM hotels WHERE slug = $1 AND is_active = true`,
    [String(slug || '').toLowerCase()]
  )
  return result.rows[0] || null
}

async function requireBookingSite(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' })
  try {
    const hotel = await loadHotel(req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    if (!(await isHotelFeatureEnabled(getPool(), hotel.id, 'feat_booking_site'))) {
      return res.status(403).json({ error: 'สาขานี้ปิดเว็บไซต์ไว้', code: 'BOOKING_SITE_DISABLED' })
    }
    req.hotel = hotel
    next()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

router.get('/:hotelSlug/booking-site', requireBookingSite, async (req, res) => {
  try {
    res.json(await getBookingSiteContent(getPool(), req.hotel))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/:hotelSlug/booking-site', requireBookingSite, async (req, res) => {
  try {
    const result = await saveBookingSiteContent(getPool(), req.hotel, req.body)
    if (result.error) return res.status(400).json({ error: result.error })
    res.json({ ok: true, content: result.content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:hotelSlug/booking-site/images/:folder', requireBookingSite, async (req, res) => {
  if (!isAllowedFolder(req.params.folder)) {
    return res.status(400).json({ error: 'ชื่อโฟลเดอร์ใช้ได้เฉพาะ a-z 0-9 - _' })
  }
  try {
    const listed = await listFolderImages(req.hotel.id, req.hotel.slug, req.params.folder)
    if (listed.error) return res.status(400).json({ error: listed.error })
    res.json({ files: listed.files })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:hotelSlug/booking-site/upload/:folder', requireBookingSite, async (req, res) => {
  if (!isAllowedFolder(req.params.folder)) {
    return res.status(400).json({ error: 'ชื่อโฟลเดอร์ใช้ได้เฉพาะ a-z 0-9 - _' })
  }
  const parsed = parseBase64Image(req.body?.image_data, req.body?.image_mime)
  if (!parsed) return res.status(400).json({ error: 'ต้องส่งรูปภาพ' })
  if (parsed.error) return res.status(400).json({ error: parsed.error })
  try {
    const saved = await saveFolderImage(req.hotel.id, req.hotel.slug, req.params.folder, parsed.buffer, parsed.ext)
    if (saved.error) return res.status(400).json({ error: saved.error })
    res.json({ url: saved.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
