const router = require('express').Router()
const auth   = require('../middleware/authMiddleware')
const admin  = require('../middleware/adminMiddleware')
const { getPool } = require('../db/pool')
const { getHotelSettings } = require('../utils/hotelSettings')
const { resolveHotelFeatures } = require('../utils/hotelFeatureFlags')
const { HOTEL_RETURN, shapeHotel, shapeHotelWithCatalog } = require('../utils/hotelShape')
const { getHotelBookingPolicies, applyBookingPolicies } = require('../utils/bookingPolicies')
const { attachHotelBranding, attachHotelsBranding, readUiImage, normalizeKind } = require('../utils/hotelBranding')
const { attachHotelTheme } = require('../utils/hotelTheme')
const { getAvailableRoomTypes, cheapestRoomType, stayNightPrice } = require('../utils/availableRooms')
const { getNetworkBranding, readNetworkUiImage } = require('../utils/networkBranding')

// GET /api/hotels — รายชื่อโรงแรมทั้งหมดที่ active
router.get('/', async (req, res) => {
  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT ${HOTEL_RETURN}
       FROM hotels
       WHERE is_active = true
       ORDER BY name ASC`
    )
    res.json(await attachHotelsBranding(pool, result.rows.map(shapeHotel)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/network-branding — ชื่อ โลโก้ รูป ธีมของหน้ารวม `/`
router.get('/network-branding', async (req, res) => {
  try {
    res.json(await getNetworkBranding(getPool()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/network-image/:kind — โลโก้ / รูปหน้ารวม
router.get('/network-image/:kind', async (req, res) => {
  try {
    const file = await readNetworkUiImage(getPool(), req.params.kind)
    if (!file) return res.status(404).json({ error: 'Image not found' })
    res.setHeader('Content-Type', file.mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(file.buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/search?checkIn&checkOut&adults&children&province — ค้นหารวมทุกสาขา
router.get('/search', async (req, res) => {
  try {
    const checkIn  = req.query.checkIn  || req.query.check_in
    const checkOut = req.query.checkOut || req.query.check_out
    const adults   = Math.max(1, parseInt(req.query.adults, 10) || 1)
    const children = Math.max(0, parseInt(req.query.children, 10) || 0)

    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'กรุณาเลือกวันเช็คอินและเช็คเอาต์' })
    }
    if (checkOut <= checkIn) {
      return res.status(400).json({ error: 'วันเช็คเอาต์ต้องหลังวันเช็คอิน' })
    }

    const nights = Math.round((new Date(`${checkOut}T00:00:00+07:00`) - new Date(`${checkIn}T00:00:00+07:00`)) / 86400000)
    const province = String(req.query.province || '').trim()
    const pool = getPool()

    const provinceRows = await pool.query(
      `SELECT DISTINCT trim(province) AS province
       FROM hotels
       WHERE is_active = true AND NULLIF(trim(province), '') IS NOT NULL
       ORDER BY 1`
    )
    const provinces = provinceRows.rows.map((row) => row.province)

    const hotelParams = []
    let hotelWhere = 'is_active = true'
    if (province) {
      hotelParams.push(province)
      hotelWhere += ` AND lower(trim(coalesce(province, ''))) = lower(trim($${hotelParams.length}))`
    }
    const hotelsResult = await pool.query(
      `SELECT ${HOTEL_RETURN}
       FROM hotels
       WHERE ${hotelWhere}
       ORDER BY name ASC`,
      hotelParams
    )
    const hotels = await attachHotelsBranding(pool, hotelsResult.rows.map(shapeHotel))

    const rows = []
    for (const hotel of hotels) {
      let types = []
      try {
        const found = await getAvailableRoomTypes(pool, hotel.id, {
          checkIn, checkOut, adults, children,
          hotelSlug: hotel.slug,
        })
        types = found.types || []
      } catch (err) {
        console.warn(`[hotels] search ${hotel.slug} failed:`, err.message)
      }
      const cheapest = cheapestRoomType(types)
      rows.push({
        id: hotel.id,
        slug: hotel.slug,
        name: hotel.name,
        description: hotel.description,
        address: hotel.address,
        city: hotel.city,
        province: hotel.province,
        star_rating: hotel.star_rating,
        phone: hotel.phone,
        check_in_time: hotel.check_in_time,
        check_out_time: hotel.check_out_time,
        cover_image: hotel.cover_image || '',
        login_image_url: hotel.login_image_url || '',
        logo_url: hotel.logo_url || '',
        available: Boolean(cheapest),
        from_price: cheapest ? stayNightPrice(cheapest) : null,
        from_display_price: cheapest?.display_price_per_night || null,
        from_discount_percent: cheapest?.discount_percent || null,
        from_room_type: cheapest?.name || null,
        available_types: types.length,
      })
    }

    rows.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      if (a.from_price == null) return 1
      if (b.from_price == null) return -1
      return a.from_price - b.from_price
    })

    res.json({
      check_in: checkIn,
      check_out: checkOut,
      nights,
      adults,
      children,
      province,
      provinces,
      hotels: rows,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug — ดึงข้อมูลโรงแรมตาม slug
router.get('/:slug', async (req, res) => {
  try {
    const pool = getPool()
    const { slug } = req.params
    const result = await pool.query(
      `SELECT ${HOTEL_RETURN}
       FROM hotels
       WHERE slug = $1 AND is_active = true`,
      [slug]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const hotel = await shapeHotelWithCatalog(pool, result.rows[0])
    applyBookingPolicies(hotel, await getHotelBookingPolicies(pool, hotel.id))
    await attachHotelBranding(pool, hotel)
    await attachHotelTheme(pool, hotel)
    res.json(hotel)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/catalog-options — ลักษณะที่ตั้ง + วิว ของสาขา
router.get('/:slug/catalog-options', async (req, res) => {
  try {
    const pool = getPool()
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const { listCatalogOptions } = require('../utils/hotelCatalogOptions')
    res.json(await listCatalogOptions(pool, hotelRow.rows[0].id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/ui-image/:kind — โลโก้ / รูปหน้าล็อกอิน
router.get('/:slug/ui-image/:kind', async (req, res) => {
  try {
    const pool = getPool()
    const kind = normalizeKind(req.params.kind)
    if (!kind) return res.status(404).json({ error: 'Not found' })
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const settingKey = kind === 'logo' ? 'ui_logo_url' : 'ui_hero_image_url'
    const settings = await getHotelSettings(pool, hotelRow.rows[0].id, [settingKey])
    const filename = String(settings[settingKey] || '').trim()
    if (!filename) return res.status(404).json({ error: 'Image not found' })
    const file = await readUiImage(hotelRow.rows[0].id, filename)
    if (!file) return res.status(404).json({ error: 'Image not found' })
    res.setHeader('Content-Type', file.mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(file.buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/features — ฟังก์ชันที่เปิดใช้ของสาขานี้
router.get('/:slug/features', async (req, res) => {
  try {
    const pool = getPool()
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const features = await resolveHotelFeatures(pool, hotelRow.rows[0].id)
    res.json({ features })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/payment — ข้อมูลโอนเงินที่แขกต้องเห็น
router.get('/:slug/payment', async (req, res) => {
  try {
    const pool = getPool()
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const settings = await getHotelSettings(pool, hotelRow.rows[0].id, [
      'promptpay_number', 'bank_name', 'bank_account_name', 'bank_account_no',
      'deposit_percent', 'payment_collect_mode',
    ])
    res.json({
      promptpay_number:      settings.promptpay_number || '',
      bank_name:             settings.bank_name || '',
      bank_account_name:     settings.bank_account_name || '',
      bank_account_no:       settings.bank_account_no || '',
      deposit_percent:       Number(settings.deposit_percent) || 30,
      payment_collect_mode:  settings.payment_collect_mode === 'full' ? 'full' : 'deposit',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/room-types — ประเภทห้องพักที่ active
router.get('/:slug/room-types', async (req, res) => {
  try {
    const pool = getPool()
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const hotelId = hotelRow.rows[0].id

    let pmsByCode = null
    try {
      const settings = await getHotelSettings(pool, hotelId, [
        'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id',
      ])
      if (settings.kiosk_enabled === 'true' && settings.kiosk_db_name && settings.kiosk_hotel_id) {
        const { syncPmsRoomTypesToPg } = require('../utils/kioskVacantRooms')
        pmsByCode = await syncPmsRoomTypesToPg(pool, hotelId, {
          dbName: settings.kiosk_db_name,
          hotelID: settings.kiosk_hotel_id,
        })
      }
    } catch (syncErr) {
      console.warn('[hotels/room-types] PMS sync skipped:', syncErr.message)
    }

    const result = await pool.query(
      `SELECT id, name, description, price_per_night,
              max_adults, max_children, bed_type, size_sqm,
              images, amenities, sort_order, view_type
       FROM room_types
       WHERE hotel_id = $1 AND is_active = true
       ORDER BY sort_order ASC, name ASC`,
      [hotelId]
    )
    const rows = pmsByCode
      ? result.rows.filter((rt) => pmsByCode.has(String(rt.name || '').trim().toUpperCase()))
      : result.rows
    const {
      resolveRoomTypeImages,
      normalizeStoredImages,
    } = require('../utils/roomTypeImages')
    res.json(rows.map((rt) => {
      const stored = normalizeStoredImages(rt.images)
      const images = resolveRoomTypeImages(stored.length ? stored : rt.images, {
        slug: req.params.slug,
        roomTypeId: rt.id,
        typeName: rt.name,
      })
      return {
        ...rt,
        images,
        cover_image: images[0] || null,
        image_files: stored,
      }
    }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/room-type-images/:roomTypeId/:filename
router.get('/:slug/room-type-images/:roomTypeId/:filename', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true LIMIT 1`,
      [req.params.slug]
    )
    if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const owned = await pool.query(
      `SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2 LIMIT 1`,
      [req.params.roomTypeId, hotel.rows[0].id]
    )
    if (!owned.rows[0]) return res.status(404).json({ error: 'ไม่พบรูป' })
    const { readRoomTypeImageFile } = require('../utils/roomTypeImages')
    const file = await readRoomTypeImageFile(hotel.rows[0].id, req.params.roomTypeId, req.params.filename)
    if (!file) return res.status(404).json({ error: 'ไม่พบรูป' })
    res.setHeader('Content-Type', file.mime)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(file.buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/pms-defaults — SysDate จาก PMS เมื่อเปิดโหมด PMS
router.get('/:slug/pms-defaults', async (req, res) => {
  try {
    const pool = getPool()
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const hotelId = hotelRow.rows[0].id

    const settings = await getHotelSettings(pool, hotelId, [
      'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id',
    ])
    const pmsEnabled = settings.kiosk_enabled === 'true'
      && Boolean(settings.kiosk_db_name)
      && Boolean(settings.kiosk_hotel_id)

    if (!pmsEnabled) {
      return res.json({ pms_enabled: false, sys_date: null })
    }

    const { getKioskSysDate } = require('../utils/kioskVacantRooms')
    const sysDate = await getKioskSysDate({
      dbName: settings.kiosk_db_name,
      hotelID: settings.kiosk_hotel_id,
    })
    res.json({ pms_enabled: true, sys_date: sysDate })
  } catch (err) {
    console.warn('[hotels] pms-defaults failed:', err.message)
    res.json({ pms_enabled: false, sys_date: null })
  }
})

// GET /api/hotels/:slug/available-rooms?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adults=2
// ดึงประเภทห้องที่ว่างในช่วงวันที่กำหนด
router.get('/:slug/available-rooms', async (req, res) => {
  try {
    const pool = getPool()
    const checkIn  = req.query.checkIn  || req.query.check_in
    const checkOut = req.query.checkOut || req.query.check_out
    const adults   = req.query.adults   ?? 1
    const children = req.query.children ?? 0

    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'checkIn and checkOut are required' })
    }
    if (checkOut <= checkIn) {
      return res.status(400).json({ error: 'checkOut must be after checkIn' })
    }

    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const hotelId = hotelRow.rows[0].id
    const adultsN = Number(adults)
    const childrenN = Number(children)

    const { types } = await getAvailableRoomTypes(pool, hotelId, {
      checkIn, checkOut, adults: adultsN, children: childrenN,
      hotelSlug: req.params.slug,
    })

    res.json(types)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/hotels/:slug/settings — hotel settings
router.get('/:slug/settings', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotelRow = await pool.query(
      `SELECT id FROM hotels WHERE slug = $1`,
      [req.params.slug]
    )
    if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const hotelId = hotelRow.rows[0].id

    const result = await pool.query(
      `SELECT setting_key, setting_value FROM hotel_settings WHERE hotel_id = $1`,
      [hotelId]
    )
    const settings = Object.fromEntries(result.rows.map(r => [r.setting_key, r.setting_value]))
    res.json(settings)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/hotels — สร้างโรงแรมใหม่ (super admin เท่านั้น)
router.post('/', auth, admin, async (req, res) => {
  try {
    const pool = getPool()
    const {
      slug, name, description,
      address, city, province, country,
      phone, email, website,
      star_rating, check_in_time, check_out_time,
    } = req.body

    if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' })

    const result = await pool.query(
      `INSERT INTO hotels (slug, name, description, address, city, province, country,
                           phone, email, website, star_rating, check_in_time, check_out_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${HOTEL_RETURN}`,
      [slug, name, description, address, city, province, country,
       phone, email, website, star_rating, check_in_time || '14:00', check_out_time || '12:00']
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already exists' })
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/hotels/:slug — แก้ไขข้อมูลโรงแรม
router.patch('/:slug', auth, admin, async (req, res) => {
  try {
    const pool = getPool()
    const allowed = [
      'name', 'description', 'address', 'city', 'province', 'country',
      'phone', 'email', 'website', 'line_url', 'star_rating',
      'check_in_time', 'check_out_time', 'map_url', 'map_embed_url',
      'location_type', 'about_hotel', 'cover_image', 'is_active',
    ]
    const updates = []
    const values  = []
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let value = req.body[key]
        if (key === 'location_type') {
          const hotelRow = await pool.query(`SELECT id FROM hotels WHERE slug = $1`, [req.params.slug])
          if (!hotelRow.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
          const { resolveLocationType } = require('../utils/hotelCatalogOptions')
          value = await resolveLocationType(pool, hotelRow.rows[0].id, value)
        }
        if (key === 'about_hotel' || key === 'line_url') {
          const text = String(value ?? '').trim()
          value = text || null
        }
        if (key === 'star_rating') {
          const n = Number(value)
          value = Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.round(n)) : null
        }
        values.push(value)
        updates.push(`${key} = $${values.length}`)
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' })

    values.push(req.params.slug)
    const result = await pool.query(
      `UPDATE hotels SET ${updates.join(', ')}
       WHERE slug = $${values.length}
       RETURNING ${HOTEL_RETURN}`,
      values
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await shapeHotelWithCatalog(pool, result.rows[0]))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
