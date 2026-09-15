const router = require('express').Router()
const { getPool, withTransaction } = require('../db/pool')
const { HOTEL_RETURN } = require('../utils/hotelShape')
const {
  getPlatformFeatureState,
  savePlatformDefaults,
  saveHotelFeatureOverrides,
} = require('../utils/hotelFeatureFlags')
const {
  listHotelAdmins,
  addHotelAdmin,
  removeHotelAdmin,
  isSuperAdminUser,
} = require('../utils/hotelAdmins')
const {
  getNetworkBranding,
  saveNetworkBranding,
  saveNetworkUiImage,
  removeNetworkUiImage,
} = require('../utils/networkBranding')
const {
  listCatalogOptions,
  saveCatalogOptions,
} = require('../utils/hotelCatalogOptions')

function normalizeSlug(raw) {
  return String(raw || '').trim().toLowerCase()
}

function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

router.get('/features', async (req, res) => {
  try {
    res.json(await getPlatformFeatureState(getPool()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/features', async (req, res) => {
  try {
    const pool = getPool()
    if (req.body?.defaults && typeof req.body.defaults === 'object') {
      await savePlatformDefaults(pool, req.body.defaults)
    }

    const hotelId = req.body?.hotel_id
    if (hotelId && req.body?.features && typeof req.body.features === 'object') {
      const hotel = await pool.query(`SELECT id FROM hotels WHERE id = $1`, [hotelId])
      if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
      await saveHotelFeatureOverrides(pool, hotelId, req.body.features)
    }

    res.json(await getPlatformFeatureState(pool))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/hotels', async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT ${HOTEL_RETURN} FROM hotels ORDER BY slug = 'default' DESC, name ASC`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/hotels', async (req, res) => {
  try {
    const pool = getPool()
    const {
      slug, name, description,
      address, city, province, country,
      phone, email, website,
      star_rating, check_in_time, check_out_time,
    } = req.body

    const normalized = normalizeSlug(slug)
    if (!normalized || !name) return res.status(400).json({ error: 'slug and name are required' })
    if (!isValidSlug(normalized)) return res.status(400).json({ error: 'slug ใช้ได้เฉพาะ a-z, 0-9 และขีดกลาง' })

    const result = await pool.query(
      `INSERT INTO hotels (slug, name, description, address, city, province, country,
                           phone, email, website, star_rating, check_in_time, check_out_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${HOTEL_RETURN}`,
      [
        normalized, name, description || null, address || null, city || null,
        province || null, country || 'Thailand', phone || null, email || null,
        website || null, star_rating || null, check_in_time || '14:00', check_out_time || '12:00',
      ]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already exists' })
    res.status(500).json({ error: err.message })
  }
})

router.get('/hotels/:hotelId/admins', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await pool.query(`SELECT id FROM hotels WHERE id = $1 LIMIT 1`, [req.params.hotelId])
    if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await listHotelAdmins(pool, hotel.rows[0].id))
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Hotel not found' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/hotels/:hotelId/admins', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await pool.query(`SELECT id FROM hotels WHERE id = $1 LIMIT 1`, [req.params.hotelId])
    if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const admin = await withTransaction(async (client) => addHotelAdmin(client, {
      hotelId: hotel.rows[0].id,
      name: req.body?.name,
      phone: req.body?.phone,
      login_id: req.body?.login_id || req.body?.phone,
      password: req.body?.password || req.body?.phone,
    }))
    res.status(201).json({ success: true, admin, message: `เพิ่มแอดมิน ${admin.name} แล้ว` })
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Hotel not found' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.get('/network-branding', async (req, res) => {
  try {
    res.json(await getNetworkBranding(getPool()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/network-branding', async (req, res) => {
  try {
    res.json(await saveNetworkBranding(getPool(), req.body || {}))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/network-branding/image', async (req, res) => {
  try {
    const result = await saveNetworkUiImage(
      getPool(),
      req.body?.kind,
      req.body?.imageData,
      req.body?.imageMime
    )
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/network-branding/image/:kind', async (req, res) => {
  try {
    const result = await removeNetworkUiImage(getPool(), req.params.kind)
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/hotels/:hotelId/admins/:userId', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await pool.query(`SELECT id FROM hotels WHERE id = $1 LIMIT 1`, [req.params.hotelId])
    if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const actorIsSuperAdmin = await isSuperAdminUser(pool, req.user.id)
    await withTransaction(async (client) => {
      await removeHotelAdmin(client, {
        hotelId: hotel.rows[0].id,
        userId: req.params.userId,
        actorIsSuperAdmin,
      })
    })
    res.json({ success: true })
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Hotel not found' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.get('/hotels/:hotelId/catalog-options', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await pool.query(`SELECT id FROM hotels WHERE id = $1 LIMIT 1`, [req.params.hotelId])
    if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await listCatalogOptions(pool, hotel.rows[0].id))
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Hotel not found' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.put('/hotels/:hotelId/catalog-options', async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await pool.query(`SELECT id FROM hotels WHERE id = $1 LIMIT 1`, [req.params.hotelId])
    if (!hotel.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    const data = await saveCatalogOptions(pool, hotel.rows[0].id, req.body || {})
    res.json(data)
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Hotel not found' })
    res.status(err.status || 500).json({ error: err.message })
  }
})

module.exports = router
