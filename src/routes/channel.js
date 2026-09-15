const router = require('express').Router({ mergeParams: true })
const { getPool } = require('../db/pool')
const {
  DAY_WINDOWS,
  listRatePlans,
  createRatePlan,
  updateRatePlan,
  deleteRatePlan,
  attachRatePlan,
  detachRatePlan,
  cancelRatePlanUse,
  datesForBulk,
  upsertAllotments,
  upsertRateColumn,
  applyStopSale,
  applyDisplayPrice,
  getCalendar,
} = require('../utils/channelManager')

async function resolveHotel(pool, slug) {
  const r = await pool.query(
    `SELECT id, slug, name FROM hotels WHERE slug = $1 AND is_active = true`,
    [slug]
  )
  return r.rows[0] || null
}

async function withHotel(req, res, fn) {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    return await fn(pool, hotel)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
}

router.get('/calendar', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const data = await getCalendar(pool, hotel.id, {
      from: req.query.from || req.query.checkIn,
      to: req.query.to || req.query.checkOut,
      days: req.query.days,
    })
    res.json({ ...data, windows: DAY_WINDOWS })
  })
})

router.get('/rate-plans', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    res.json(await listRatePlans(pool, hotel.id))
  })
})

router.post('/rate-plans', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const plan = await createRatePlan(pool, hotel.id, req.body?.name, req.body || {})
    const roomTypeId = req.body?.room_type_id
    if (roomTypeId) await attachRatePlan(pool, hotel.id, roomTypeId, plan.id)
    res.status(201).json(plan)
  })
})

router.patch('/rate-plans/:id', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    res.json(await updateRatePlan(pool, hotel.id, req.params.id, req.body || {}))
  })
})

router.delete('/rate-plans/:id', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    await deleteRatePlan(pool, hotel.id, req.params.id)
    res.json({ success: true })
  })
})

router.post('/rate-plans/:id/cancel', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const result = await cancelRatePlanUse(pool, hotel.id, req.params.id, req.body || {})
    res.json(result)
  })
})

router.post('/room-types/:roomTypeId/rate-plans', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    let planId = req.body?.rate_plan_id
    if (!planId && req.body?.name) {
      const plan = await createRatePlan(pool, hotel.id, req.body.name, req.body || {})
      planId = plan.id
    }
    if (!planId) return res.status(400).json({ error: 'เลือกหรือสร้างเรทแพลน' })
    await attachRatePlan(pool, hotel.id, req.params.roomTypeId, planId)
    res.status(201).json({ success: true, rate_plan_id: planId })
  })
})

router.delete('/room-types/:roomTypeId/rate-plans/:ratePlanId', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    await detachRatePlan(pool, hotel.id, req.params.roomTypeId, req.params.ratePlanId)
    res.json({ success: true })
  })
})

router.put('/allotments', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const { room_type_id, date_from, date_to, weekdays, rooms_to_sell } = req.body || {}
    if (!room_type_id) return res.status(400).json({ error: 'เลือกประเภทห้อง' })
    const dates = datesForBulk(date_from, date_to, weekdays)
    const result = await upsertAllotments(pool, hotel.id, room_type_id, dates, rooms_to_sell)
    res.json(result)
  })
})

router.put('/rates', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const { room_type_id, rate_plan_id, date_from, date_to, weekdays, price, abf } = req.body || {}
    if (!room_type_id || !rate_plan_id) {
      return res.status(400).json({ error: 'เลือกประเภทห้องและเรทแพลน' })
    }
    const hasPrice = Object.prototype.hasOwnProperty.call(req.body || {}, 'price')
    const hasAbf = Object.prototype.hasOwnProperty.call(req.body || {}, 'abf')
    if (!hasPrice && !hasAbf) {
      return res.status(400).json({ error: 'ระบุราคาห้องหรือราคาอาหารเช้า' })
    }
    const dates = datesForBulk(date_from, date_to, weekdays)
    let result = { updated: 0 }
    if (hasPrice) {
      result = await upsertRateColumn(pool, hotel.id, room_type_id, rate_plan_id, dates, 'price', price)
    }
    if (hasAbf) {
      result = await upsertRateColumn(pool, hotel.id, room_type_id, rate_plan_id, dates, 'abf', abf)
    }
    res.json(result)
  })
})

/** หยุดขาย / เปิดขายอีกครั้ง ตามช่วงวัน — mode: room_type | rate_plan | room_type_rate_plan */
router.post('/stop-sale', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const result = await applyStopSale(pool, hotel.id, req.body || {})
    res.json(result)
  })
})

/** ราคาแสดง (ขีดฆ่า) — input_mode: percent | amount; action: set | clear */
router.post('/display-price', async (req, res) => {
  await withHotel(req, res, async (pool, hotel) => {
    const result = await applyDisplayPrice(pool, hotel.id, req.body || {})
    res.json(result)
  })
})

module.exports = router
