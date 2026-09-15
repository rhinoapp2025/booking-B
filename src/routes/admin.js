const router  = require('express').Router()
const auth    = require('../middleware/authMiddleware')
const { getPool, withTransaction } = require('../db/pool')
const { emitBookingChanged } = require('../utils/bookingEvents')
const { notifyBookingCancelledChat } = require('../utils/bookingChatNotify')
const { deletePaymentSlipByBookingId, readBookingPaymentSlip, MIME_EXT: SLIP_MIME_EXT } = require('../utils/bookingPaymentSlips')
const { getChatNotifySettings, setChatNotifySettings } = require('../utils/chatNotifySettings')
const { getHotelSettings, setHotelSettings } = require('../utils/hotelSettings')
const { setCouponSettings, awardCompletionPoints } = require('../utils/couponSettings')
const {
  listHotelAdmins,
  addHotelAdmin,
  removeHotelAdmin,
  assertManagesHotel,
  isSuperAdminUser,
} = require('../utils/hotelAdmins')
const { HOTEL_RETURN, shapeHotel, shapeHotelWithCatalog, pickHotelFields, pickConfigSettings, CONFIG_SETTING_KEYS } = require('../utils/hotelShape')
const { resolveHotelMapEmbedUrl } = require('../utils/googleMapEmbed')
const { isHotelFeatureEnabled } = require('../utils/hotelFeatureFlags')
const { getHotelBookingPolicies, applyBookingPolicies, normalizeCancellationPolicy } = require('../utils/bookingPolicies')
const { attachHotelBranding, saveHotelUiImage, removeHotelUiImage } = require('../utils/hotelBranding')
const { attachHotelTheme } = require('../utils/hotelTheme')
const { ROOM_HOLD_STATUS_SQL } = require('../utils/availableRooms')
const { notifyAdminNewBookingChat } = require('../utils/bookingChatNotify')
const {
  maybePushBookingToPms, pushBookingToPms, maybeSyncPmsStatuses, maybeCancelBookingInPms,
} = require('../utils/kioskSaveBooking')

function clipText(value, max) {
  const s = String(value || '').trim()
  if (!s) return null
  return s.slice(0, max)
}

function calcNights(checkIn, checkOut) {
  const a = new Date(checkIn)
  const b = new Date(checkOut)
  return Math.round((b - a) / 86400000)
}

const COUPON_SETTING_KEYS = [
  'coupon_discount_percent',
  'coupon_required_points',
  'coupon_completion_points',
]

router.use(auth)

async function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' })
  try {
    const pool = getPool()
      const result = await pool.query(
      `SELECT is_super_admin FROM users WHERE id = $1 LIMIT 1`,
      [req.user.id]
    )
    if (!result.rows[0]?.is_super_admin) {
      return res.status(403).json({ error: 'เฉพาะแอดมิน default เท่านั้น' })
    }
    req.user.is_super_admin = true
    next()
  } catch (err) {
    next(err)
  }
}

router.use('/platform', requireSuperAdmin, require('./platform'))

// ── middleware: must be hotel admin ──────────────────────────────────────────

async function requireHotelAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' })
  next()
}

async function resolveHotel(pool, slug) {
  const r = await pool.query(
    `SELECT id, slug, name FROM hotels WHERE slug = $1 AND is_active = true`, [slug]
  )
  return r.rows[0] || null
}

// ── bookings ──────────────────────────────────────────────────────────────────

// GET /api/admin/:hotelSlug/bookings — รายการจองทั้งหมด
router.get('/:hotelSlug/bookings', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    await maybeSyncPmsStatuses(pool, hotel.id)

    const { status, check_in_date, check_in_on, check_out_date, exclude_cancelled, page = 1, limit = 50 } = req.query
    const conditions = ['b.hotel_id = $1']
    const params     = [hotel.id]

    if (status) {
      params.push(status)
      conditions.push(`b.status = $${params.length}`)
    } else if (String(exclude_cancelled) === '1' || String(exclude_cancelled) === 'true') {
      conditions.push(`b.status <> 'cancelled'`)
    }
    if (check_in_on) {
      params.push(String(check_in_on).slice(0, 10))
      conditions.push(`b.check_in_date = $${params.length}::date`)
    } else if (check_in_date) {
      params.push(check_in_date)
      conditions.push(`b.check_in_date >= $${params.length}`)
    }
    if (check_out_date)  { params.push(check_out_date);  conditions.push(`b.check_out_date <= $${params.length}`) }

    const offset = (Number(page) - 1) * Number(limit)
    params.push(Number(limit)); params.push(offset)

    const result = await pool.query(
      `SELECT b.id, b.check_in_date, b.check_out_date, b.num_adults, b.num_children,
              b.status, b.total_price, b.deposit_amount, b.special_requests,
              b.cancelled_reason, b.cancelled_by, b.guest_name, b.guest_phone, b.guest_email,
              b.guest_title, b.guest_first_name, b.guest_last_name, b.guest_sex, b.guest_nation,
              b.guest_national_id, b.guest_passport, b.guest_birthday, b.guest_car_no,
              b.guest_address1, b.guest_address2, b.guest_address3,
              b.include_breakfast, b.breakfast_count, b.rate_plan_id,
              rp.name AS rate_plan_name,
              b.pms_resv_no, b.pms_room_no, b.pms_ota_booking_no, b.pms_sent_at, b.pms_last_error,
              b.created_at, b.updated_at,
              u.name AS user_name, u.email AS user_email,
              json_agg(json_build_object(
                'room_number', r.room_number, 'floor', r.floor,
                'room_type_name', rt.name, 'price_per_night', br.price_per_night,
                'nights', br.nights, 'subtotal', br.subtotal
              )) AS rooms,
              (SELECT status FROM booking_payment_slips WHERE booking_id = b.id LIMIT 1) AS slip_status
        FROM bookings b
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN rate_plans rp ON rp.id = b.rate_plan_id
       LEFT JOIN booking_rooms br ON br.booking_id = b.id
       LEFT JOIN rooms r ON r.id = br.room_id
       LEFT JOIN room_types rt ON rt.id = br.room_type_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY b.id, u.name, u.email, rp.name
       ORDER BY b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    const policies = await getHotelBookingPolicies(pool, hotel.id)
    res.json(result.rows.map((row) => applyBookingPolicies(row, policies)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** จอง walk-in เลือกเลขห้อง — ใช้ได้เฉพาะโหมดจัดการห้องเอง (ไม่เปิด PMS) */
router.post('/:hotelSlug/bookings', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const {
      room_id,
      check_in_date,
      check_out_date,
      num_adults = 1,
      num_children = 0,
      rate_plan_id,
      include_breakfast,
      breakfast_count,
      special_requests,
      guest_title,
      guest_first_name,
      guest_last_name,
      guest_sex,
      guest_nation,
      guest_national_id,
      guest_passport,
      guest_birthday,
      guest_phone,
      guest_email,
      guest_car_no,
      guest_address1,
      guest_address2,
      guest_address3,
      guest_name,
    } = req.body || {}

    if (!room_id || !check_in_date || !check_out_date) {
      return res.status(400).json({ error: 'เลือกห้องและวันที่เข้า–ออก' })
    }
    if (!guest_title || !guest_sex || !String(guest_first_name || '').trim() || !String(guest_last_name || '').trim()) {
      return res.status(400).json({ error: 'กรอกคำนำหน้า เพศ ชื่อ และนามสกุล' })
    }
    if (check_out_date <= check_in_date) {
      return res.status(400).json({ error: 'วันเช็คเอาต์ต้องหลังวันเช็คอิน' })
    }
    const minCheckIn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
    if (check_in_date < minCheckIn) {
      return res.status(400).json({ error: 'วันเช็คอินต้องไม่น้อยกว่าวันนี้' })
    }

    const nights = calcNights(check_in_date, check_out_date)
    if (nights < 1) return res.status(400).json({ error: 'จำนวนคืนไม่ถูกต้อง' })

    const booking = await withTransaction(async (client) => {
      const roomResult = await client.query(
        `SELECT r.id, r.room_number, r.room_type_id, r.status, rt.name AS room_type_name
         FROM rooms r
         JOIN room_types rt ON rt.id = r.room_type_id
         WHERE r.id = $1 AND r.hotel_id = $2
         FOR UPDATE OF r`,
        [room_id, hotel.id]
      )
      const room = roomResult.rows[0]
      if (!room) throw Object.assign(new Error('ไม่พบห้องที่เลือก'), { status: 404 })
      if (room.status !== 'available') {
        throw Object.assign(new Error('ห้องนี้ไม่ว่างให้จอง'), { status: 409 })
      }

      const conflict = await client.query(
        `SELECT 1 FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id
         WHERE br.room_id = $1 AND ${ROOM_HOLD_STATUS_SQL}
           AND b.check_in_date < $3 AND b.check_out_date > $2
         LIMIT 1`,
        [room.id, check_in_date, check_out_date]
      )
      if (conflict.rows[0]) {
        throw Object.assign(new Error('ห้องนี้ถูกจองในช่วงวันที่เลือกแล้ว'), { status: 409 })
      }

      const { getChannelQuotes, quoteChannelStay, parseBreakfastChoice } = require('../utils/channelManager')
      const partySize = Math.max(1, Number(num_adults) + Number(num_children))
      let breakfastChoice = parseBreakfastChoice(include_breakfast, breakfast_count, partySize)
      let chosenRatePlanId = rate_plan_id || null

      const channelQuotes = await getChannelQuotes(client, hotel.id, room.room_type_id, check_in_date, check_out_date)
      if (channelQuotes.channel_closed) {
        throw Object.assign(new Error('ประเภทห้องนี้หยุดขายในช่วงวันที่เลือก'), { status: 409 })
      }
      if (!channelQuotes.plans.length) {
        throw Object.assign(new Error('ยังไม่ได้ตั้งราคาขายในช่วงวันที่เลือก — ไปตั้งที่แท็บราคาขาย'), { status: 409 })
      }
      if (!chosenRatePlanId) {
        if (channelQuotes.plans.length === 1) chosenRatePlanId = channelQuotes.plans[0].id
        else throw Object.assign(new Error('กรุณาเลือกเรทแพลน'), { status: 400 })
      }
      const pickedPlan = channelQuotes.plans.find((p) => p.id === chosenRatePlanId)
      if (!pickedPlan) {
        throw Object.assign(new Error('เรทแพลนนี้ใช้ไม่ได้ในช่วงวันที่เลือก'), { status: 400 })
      }
      breakfastChoice = parseBreakfastChoice(pickedPlan.includes_breakfast, breakfast_count, partySize)

      const channelQuote = await quoteChannelStay(client, hotel.id, room.room_type_id, check_in_date, check_out_date, {
        rate_plan_id: chosenRatePlanId,
        includeBreakfast: breakfastChoice.includeBreakfast,
        breakfastCount: breakfastChoice.breakfastCount,
        partySize,
      })
      if (!channelQuote) {
        throw Object.assign(new Error('คำนวณราคาขายไม่สำเร็จในช่วงวันที่เลือก'), { status: 409 })
      }
      if (breakfastChoice.includeBreakfast && !channelQuote.includes_breakfast) {
        throw Object.assign(new Error('เรทแพลนนี้ไม่มีอาหารเช้าให้เลือก'), { status: 400 })
      }
      chosenRatePlanId = channelQuote.rate_plan_id
      const pricePerNight = channelQuote.roomAvg
      const subtotal = channelQuote.total
      breakfastChoice = {
        includeBreakfast: channelQuote.includes_breakfast,
        breakfastCount: channelQuote.breakfast_count,
      }

      const fullGuestName = [
        guest_title, guest_first_name, guest_last_name,
      ].filter(Boolean).join(' ').trim() || guest_name || null

      // walk-in จากแอดมิน: ยืนยันทันที ไม่รอสลิป
      const bResult = await client.query(
        `INSERT INTO bookings
           (hotel_id, user_id, check_in_date, check_out_date, num_adults, num_children,
            status, total_price, deposit_amount, special_requests,
            guest_name, guest_phone, guest_email,
            guest_title, guest_first_name, guest_last_name, guest_sex, guest_nation,
            guest_national_id, guest_passport, guest_birthday, guest_car_no,
            guest_address1, guest_address2, guest_address3,
            include_breakfast, breakfast_count, rate_plan_id)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed',$7,0,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING *`,
        [
          hotel.id, req.user.id, check_in_date, check_out_date,
          Math.max(1, Number(num_adults) || 1), Math.max(0, Number(num_children) || 0),
          subtotal, special_requests || null,
          fullGuestName, guest_phone || null, guest_email || null,
          guest_title || null, guest_first_name || null, guest_last_name || null,
          guest_sex || null, guest_nation || null,
          guest_national_id || null, guest_passport || null,
          guest_birthday || null, guest_car_no || null,
          clipText(guest_address1, 60), clipText(guest_address2, 60), clipText(guest_address3, 60),
          breakfastChoice.includeBreakfast,
          breakfastChoice.breakfastCount,
          chosenRatePlanId,
        ]
      )
      const newBooking = bResult.rows[0]
      await client.query(
        `INSERT INTO booking_rooms (booking_id, room_id, room_type_id, price_per_night, nights, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newBooking.id, room.id, room.room_type_id, pricePerNight, nights, subtotal]
      )
      return {
        ...newBooking,
        rooms: [{
          room_number: room.room_number,
          room_type_name: room.room_type_name,
          price_per_night: pricePerNight,
          nights,
          subtotal,
        }],
      }
    })

    notifyAdminNewBookingChat(pool, hotel.id, booking.id).catch(() => null)
    emitBookingChanged(hotel.id, { type: 'created', booking_id: booking.id })
    res.status(201).json(booking)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/:hotelSlug/bookings/:bookingId/status
router.patch('/:hotelSlug/bookings/:bookingId/status', requireHotelAdmin, async (req, res) => {
  try {
    const pool   = getPool()
    const hotel  = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel)  return res.status(404).json({ error: 'Hotel not found' })
    const { status, reason, guest } = req.body

    const VALID = ['pending','confirmed','checked_in','checked_out','cancelled','no_show']
    if (!VALID.includes(status)) return res.status(400).json({ error: `Invalid status. Valid: ${VALID.join(', ')}` })

    const kioskSettings = await getHotelSettings(pool, hotel.id, ['kiosk_enabled'])
    const pmsOn = kioskSettings.kiosk_enabled === 'true'
    if (pmsOn && (status === 'checked_in' || status === 'checked_out')) {
      return res.status(409).json({ error: 'ใช้ PMS อยู่ — เช็คอินที่ระบบ PMS ไม่ต้องเช็คอินบนเว็บ' })
    }

    let pmsCancel = null
    if (status === 'cancelled') {
      const current = await pool.query(
        `SELECT status, pms_resv_no FROM bookings WHERE id = $1 AND hotel_id = $2`,
        [req.params.bookingId, hotel.id]
      )
      const row = current.rows[0]
      if (!row) return res.status(404).json({ error: 'Booking not found' })
      if (['checked_in', 'checked_out'].includes(row.status)) {
        return res.status(409).json({ error: 'จองนี้เช็คอิน/เช็คเอาต์แล้ว ยกเลิกไม่ได้' })
      }
      if (row.pms_resv_no) {
        pmsCancel = await maybeCancelBookingInPms(pool, hotel.id, req.params.bookingId)
        if (pmsCancel?.error) {
          return res.status(502).json({ error: `ยกเลิกใน PMS ไม่สำเร็จ: ${pmsCancel.error}`, pms: pmsCancel })
        }
      }
    }

    const setClauses = ['status = $3', 'updated_at = NOW()']
    const params = [req.params.bookingId, hotel.id, status]
    if (status === 'cancelled') {
      setClauses.push(`cancelled_by = 'admin'`, `cancelled_at = NOW()`)
      if (reason) { params.push(reason); setClauses.push(`cancelled_reason = $${params.length}`) }
    }

    if (status === 'checked_in' && !pmsOn && guest && typeof guest === 'object') {
      const title = String(guest.guest_title || '').trim()
      const sex = String(guest.guest_sex || '').trim()
      const firstName = String(guest.guest_first_name || '').trim()
      const lastName = String(guest.guest_last_name || '').trim()
      if (!title || !sex || !firstName || !lastName) {
        return res.status(400).json({ error: 'กรอกคำนำหน้า เพศ ชื่อ และนามสกุล' })
      }
      if (!['male', 'female'].includes(sex)) {
        return res.status(400).json({ error: 'เพศไม่ถูกต้อง' })
      }
      const fullName = [title, firstName, lastName].filter(Boolean).join(' ')
      const birthday = String(guest.guest_birthday || '').slice(0, 10)
      const guestFields = [
        ['guest_title', title],
        ['guest_first_name', firstName],
        ['guest_last_name', lastName],
        ['guest_sex', sex],
        ['guest_nation', String(guest.guest_nation || '').trim() || null],
        ['guest_national_id', String(guest.guest_national_id || '').trim() || null],
        ['guest_passport', String(guest.guest_passport || '').trim() || null],
        ['guest_birthday', /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday : null],
        ['guest_phone', String(guest.guest_phone || '').trim() || null],
        ['guest_email', String(guest.guest_email || '').trim() || null],
        ['guest_car_no', String(guest.guest_car_no || '').trim() || null],
        ['guest_address1', String(guest.guest_address1 || '').trim() || null],
        ['guest_address2', String(guest.guest_address2 || '').trim() || null],
        ['guest_address3', String(guest.guest_address3 || '').trim() || null],
        ['guest_name', fullName],
        ['special_requests', String(guest.special_requests || '').trim() || null],
      ]
      for (const [col, val] of guestFields) {
        params.push(val)
        setClauses.push(`${col} = $${params.length}`)
      }
    }

    const result = await pool.query(
      `UPDATE bookings SET ${setClauses.join(', ')} WHERE id = $1 AND hotel_id = $2 RETURNING *`,
      params
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Booking not found' })

    if (status === 'checked_out' && result.rows[0].user_id) {
      try {
        await withTransaction(async (client) => {
          await awardCompletionPoints(client, hotel.id, result.rows[0].user_id, req.params.bookingId)
        })
      } catch (err) {
        console.error('awardCompletionPoints:', err.message)
      }
    }

    if (status === 'cancelled') {
      await deletePaymentSlipByBookingId(pool, req.params.bookingId).catch(() => null)
      notifyBookingCancelledChat(pool, hotel.id, req.params.bookingId).catch(() => null)
    }

    let pms = pmsCancel
    if (status === 'confirmed') {
      pms = await maybePushBookingToPms(pool, hotel.id, req.params.bookingId)
    }

    emitBookingChanged(hotel.id, { type: 'status_changed', booking_id: req.params.bookingId })
    res.json({ ...result.rows[0], pms })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/:hotelSlug/bookings/:bookingId/slip — ดูสลิป
router.get('/:hotelSlug/bookings/:bookingId/slip', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const slipResult = await pool.query(
      `SELECT slip_filename FROM booking_payment_slips WHERE booking_id = $1 AND hotel_id = $2`,
      [req.params.bookingId, hotel.id]
    )
    if (!slipResult.rows[0]) return res.status(404).json({ error: 'Slip not found' })

    const { buffer, ext } = await readBookingPaymentSlip(slipResult.rows[0].slip_filename)
    res.set('Content-Type', SLIP_MIME_EXT[ext] || 'application/octet-stream').send(buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/:hotelSlug/bookings/:bookingId/slip — ยืนยัน/ปฏิเสธสลิป
router.patch('/:hotelSlug/bookings/:bookingId/slip', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const { slip_status } = req.body
    if (!['approved','rejected'].includes(slip_status)) {
      return res.status(400).json({ error: 'slip_status must be approved or rejected' })
    }

    const slipDbStatus = slip_status === 'approved' ? 'confirmed' : 'cancelled'
    await pool.query(
      `UPDATE booking_payment_slips SET status = $1, updated_at = NOW() WHERE booking_id = $2 AND hotel_id = $3`,
      [slipDbStatus, req.params.bookingId, hotel.id]
    )

    let pms = null
    if (slip_status === 'approved') {
      await pool.query(
        `UPDATE bookings SET status = 'confirmed', updated_at = NOW() WHERE id = $1 AND hotel_id = $2`,
        [req.params.bookingId, hotel.id]
      )
      pms = await maybePushBookingToPms(pool, hotel.id, req.params.bookingId)
      emitBookingChanged(hotel.id, { type: 'slip_approved', booking_id: req.params.bookingId })
    }

    res.json({ ok: true, pms })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/:hotelSlug/bookings/:bookingId/push-pms — ส่งไป PMS อีกครั้ง
router.post('/:hotelSlug/bookings/:bookingId/push-pms', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const existing = await pool.query(
      `SELECT status, pms_resv_no FROM bookings WHERE id = $1 AND hotel_id = $2`,
      [req.params.bookingId, hotel.id]
    )
    const booking = existing.rows[0]
    if (!booking) return res.status(404).json({ error: 'Booking not found' })
    if (['cancelled', 'no_show'].includes(booking.status)) {
      return res.status(400).json({ error: 'จองนี้ยกเลิกแล้ว ส่ง PMS ไม่ได้' })
    }

    try {
      const result = await pushBookingToPms(pool, hotel.id, req.params.bookingId)
      emitBookingChanged(hotel.id, { type: 'pms_pushed', booking_id: req.params.bookingId })
      res.json({ ok: true, ...result })
    } catch (err) {
      res.status(502).json({ error: err.message || 'ส่ง PMS ไม่สำเร็จ' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/:hotelSlug/bookings/:bookingId — ลบการจองถาวร (เฉพาะซูเปอร์แอดมิน)
router.delete('/:hotelSlug/bookings/:bookingId', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    if (!(await isSuperAdminUser(pool, req.user.id))) {
      return res.status(403).json({ error: 'เฉพาะซูเปอร์แอดมินเท่านั้น' })
    }
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const existing = await pool.query(
      `SELECT id, status, pms_resv_no FROM bookings WHERE id = $1 AND hotel_id = $2`,
      [req.params.bookingId, hotel.id]
    )
    const booking = existing.rows[0]
    if (!booking) return res.status(404).json({ error: 'Booking not found' })

    let pms = null
    if (booking.pms_resv_no && booking.status !== 'cancelled') {
      pms = await maybeCancelBookingInPms(pool, hotel.id, req.params.bookingId)
      if (pms?.error) {
        return res.status(502).json({ error: `ยกเลิกใน PMS ไม่สำเร็จ: ${pms.error}`, pms })
      }
    }

    await deletePaymentSlipByBookingId(pool, req.params.bookingId).catch(() => null)

    const reviews = await pool.query(
      `SELECT id, images FROM reviews WHERE booking_id = $1 AND hotel_id = $2`,
      [req.params.bookingId, hotel.id]
    )
    const { deleteReviewImageFile } = require('../utils/reviewImages')
    for (const row of reviews.rows) {
      const images = Array.isArray(row.images) ? row.images : []
      for (const name of images) {
        if (name) await deleteReviewImageFile(hotel.id, name).catch(() => null)
      }
    }

    await withTransaction(async (client) => {
      await client.query(`UPDATE point_logs SET booking_id = NULL WHERE booking_id = $1`, [req.params.bookingId])
      await client.query(`DELETE FROM reviews WHERE booking_id = $1 AND hotel_id = $2`, [
        req.params.bookingId,
        hotel.id,
      ])
      const deleted = await client.query(
        `DELETE FROM bookings WHERE id = $1 AND hotel_id = $2 RETURNING id`,
        [req.params.bookingId, hotel.id]
      )
      if (!deleted.rows[0]) {
        throw Object.assign(new Error('Booking not found'), { status: 404 })
      }
    })

    emitBookingChanged(hotel.id, { type: 'deleted', booking_id: req.params.bookingId })
    res.json({ ok: true, id: req.params.bookingId, pms })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── rooms & room types ────────────────────────────────────────────────────────

async function assertLocalInventory(pool, hotelId) {
  const settings = await getHotelSettings(pool, hotelId, ['kiosk_enabled'])
  if (settings.kiosk_enabled === 'true') {
    const err = new Error('กำลังใช้ PMS อยู่ — ปิด PMS ก่อนจึงจะเพิ่มหรือแก้ห้องในระบบจองได้')
    err.status = 409
        throw err
      }
}

// GET /api/admin/:hotelSlug/room-types
router.get('/:hotelSlug/room-types', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    let pmsByCode = null

    // เปิด PMS: ซิงก์จากตาราง RmType (master) ไม่ใช้ชื่อหลุดจาก RmSetupNum / ประเภทเก่าใน PG
    try {
      const settings = await getHotelSettings(pool, hotel.id, [
        'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id',
      ])
      if (settings.kiosk_enabled === 'true' && settings.kiosk_db_name && settings.kiosk_hotel_id) {
        const { syncPmsRoomTypesToPg } = require('../utils/kioskVacantRooms')
        pmsByCode = await syncPmsRoomTypesToPg(pool, hotel.id, {
          dbName: settings.kiosk_db_name,
          hotelID: settings.kiosk_hotel_id,
        })
      }
    } catch (syncErr) {
      console.warn('[room-types] PMS sync skipped:', syncErr.message)
    }

    const result = await pool.query(
      `SELECT rt.*, COUNT(r.id)::int AS room_count
       FROM room_types rt
       LEFT JOIN rooms r ON r.room_type_id = rt.id
       WHERE rt.hotel_id = $1
       GROUP BY rt.id ORDER BY rt.name`,
      [hotel.id]
    )
    const {
      normalizeStoredImages,
      resolveRoomTypeImages,
    } = require('../utils/roomTypeImages')
    const rows = pmsByCode
      ? result.rows.filter((rt) => pmsByCode.has(String(rt.name || '').trim().toUpperCase()))
      : result.rows
    res.json(rows.map((rt) => {
      const stored = normalizeStoredImages(rt.images)
      const images = resolveRoomTypeImages(stored.length ? stored : rt.images, {
        slug: hotel.slug,
        roomTypeId: rt.id,
        typeName: rt.name,
      })
      const pms = pmsByCode?.get(String(rt.name || '').trim().toUpperCase())
      return {
        ...rt,
        images,
        cover_image: images[0] || null,
        image_files: stored,
        pms_name: pms?.name || null,
        display_name: pms?.label || rt.name,
      }
    }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/:hotelSlug/room-types
router.post('/:hotelSlug/room-types', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const { name, description, price_per_night, max_adults, max_children, bed_type, size_sqm, amenities, images, view_type } = req.body
    if (!name) {
      return res.status(400).json({ error: 'name is required' })
    }

    const { normalizeViewType } = require('../utils/roomTypeImages')
    const { resolveViewType } = require('../utils/hotelCatalogOptions')
    let view = null
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'view_type')) {
      const normalized = normalizeViewType(view_type)
      if (normalized === undefined) return res.status(400).json({ error: 'วิวไม่ถูกต้อง' })
      if (normalized == null) view = null
      else {
        view = await resolveViewType(pool, hotel.id, normalized)
        if (view === undefined) return res.status(400).json({ error: 'วิวไม่ได้อยู่ในรายการของสาขานี้' })
      }
    }

    const price = price_per_night == null || price_per_night === ''
      ? 0
      : Number(price_per_night)
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'ราคาไม่ถูกต้อง' })
    }

    const result = await pool.query(
      `INSERT INTO room_types (hotel_id, name, description, price_per_night, max_adults, max_children, bed_type, size_sqm, amenities, images, view_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [hotel.id, name, description || null, price,
       max_adults ?? 10, max_children ?? 10,
       bed_type || 'double', size_sqm || null, JSON.stringify(amenities || []), JSON.stringify(images || []),
       view]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    if (err.code === '23505') return res.status(409).json({ error: 'ชื่อประเภทห้องนี้มีอยู่แล้ว' })
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/:hotelSlug/room-types/:id
router.patch('/:hotelSlug/room-types/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const fields  = []
    const params  = [hotel.id, req.params.id]
    const allowed = ['name','description','price_per_night','max_adults','max_children','bed_type','size_sqm','amenities','images','is_active']
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        params.push(['amenities','images'].includes(key) ? JSON.stringify(req.body[key]) : req.body[key])
        fields.push(`${key} = $${params.length}`)
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'view_type')) {
      const { normalizeViewType } = require('../utils/roomTypeImages')
      const { resolveViewType } = require('../utils/hotelCatalogOptions')
      const normalized = normalizeViewType(req.body.view_type)
      if (normalized === undefined) return res.status(400).json({ error: 'วิวไม่ถูกต้อง' })
      let view = null
      if (normalized != null) {
        view = await resolveViewType(pool, hotel.id, normalized)
        if (view === undefined) return res.status(400).json({ error: 'วิวไม่ได้อยู่ในรายการของสาขานี้' })
      }
      params.push(view)
      fields.push(`view_type = $${params.length}`)
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' })
    fields.push('updated_at = NOW()')

    const result = await pool.query(
      `UPDATE room_types SET ${fields.join(', ')} WHERE hotel_id = $1 AND id = $2 RETURNING *`,
      params
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Room type not found' })
    res.json(result.rows[0])
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    if (err.code === '23505') return res.status(409).json({ error: 'ชื่อประเภทห้องนี้มีอยู่แล้ว' })
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/:hotelSlug/room-types/:id/details — รายละเอียด/วิว/ลำดับรูป (ใช้ได้แม้เปิด PMS)
router.patch('/:hotelSlug/room-types/:id/details', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const {
      normalizeViewType,
      normalizeStoredImages,
      resolveRoomTypeImages,
      MAX_IMAGES,
    } = require('../utils/roomTypeImages')

    const current = await pool.query(
      `SELECT * FROM room_types WHERE hotel_id = $1 AND id = $2`,
      [hotel.id, req.params.id]
    )
    if (!current.rows[0]) return res.status(404).json({ error: 'Room type not found' })

    const fields = []
    const params = [hotel.id, req.params.id]
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) {
      params.push(String(req.body.description || '').trim() || null)
      fields.push(`description = $${params.length}`)
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'view_type')) {
      const { resolveViewType } = require('../utils/hotelCatalogOptions')
      const view = normalizeViewType(req.body.view_type)
      if (view === undefined) return res.status(400).json({ error: 'วิวไม่ถูกต้อง' })
      let resolved = null
      if (view != null) {
        resolved = await resolveViewType(pool, hotel.id, view)
        if (resolved === undefined) return res.status(400).json({ error: 'วิวไม่ได้อยู่ในรายการของสาขานี้' })
      }
      params.push(resolved)
      fields.push(`view_type = $${params.length}`)
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'images')) {
      const next = normalizeStoredImages(req.body.images)
      if (next.length > MAX_IMAGES) {
        return res.status(400).json({ error: `อัปโหลดรูปได้ไม่เกิน ${MAX_IMAGES} รูป` })
      }
      const existing = new Set(normalizeStoredImages(current.rows[0].images))
      if (next.some((name) => !existing.has(name))) {
        return res.status(400).json({ error: 'ลำดับรูปมีไฟล์ที่ไม่รู้จัก — อัปโหลดก่อนแล้วค่อยจัดลำดับ' })
      }
      params.push(JSON.stringify(next))
      fields.push(`images = $${params.length}`)
    }
    if (!fields.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' })
    fields.push('updated_at = NOW()')

    const result = await pool.query(
      `UPDATE room_types SET ${fields.join(', ')} WHERE hotel_id = $1 AND id = $2 RETURNING *`,
      params
    )
    const row = result.rows[0]
    const stored = normalizeStoredImages(row.images)
    const images = resolveRoomTypeImages(stored, {
      slug: hotel.slug,
      roomTypeId: row.id,
      typeName: row.name,
    })
    res.json({
      ...row,
      images,
      cover_image: images[0] || null,
      image_files: stored,
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// POST /api/admin/:hotelSlug/room-types/:id/images — อัปโหลดรูป (สูงสุด 5)
router.post('/:hotelSlug/room-types/:id/images', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const {
      parseBase64Image,
      saveRoomTypeImage,
      normalizeStoredImages,
      resolveRoomTypeImages,
      MAX_IMAGES,
    } = require('../utils/roomTypeImages')

    const current = await pool.query(
      `SELECT * FROM room_types WHERE hotel_id = $1 AND id = $2`,
      [hotel.id, req.params.id]
    )
    if (!current.rows[0]) return res.status(404).json({ error: 'Room type not found' })

    const stored = normalizeStoredImages(current.rows[0].images)
    if (stored.length >= MAX_IMAGES) {
      return res.status(400).json({ error: `อัปโหลดรูปได้ไม่เกิน ${MAX_IMAGES} รูป` })
    }

    const parsed = parseBase64Image(req.body?.image_data || req.body?.image, req.body?.image_mime || req.body?.mime)
    if (!parsed || parsed.error) return res.status(400).json({ error: parsed?.error || 'รูปไม่ถูกต้อง' })

    const filename = await saveRoomTypeImage(hotel.id, req.params.id, parsed.buffer, parsed.ext)
    const next = [...stored, filename].slice(0, MAX_IMAGES)
    const result = await pool.query(
      `UPDATE room_types SET images = $3::jsonb, updated_at = NOW()
       WHERE hotel_id = $1 AND id = $2 RETURNING *`,
      [hotel.id, req.params.id, JSON.stringify(next)]
    )
    const row = result.rows[0]
    const images = resolveRoomTypeImages(next, {
      slug: hotel.slug,
      roomTypeId: row.id,
      typeName: row.name,
    })
    res.status(201).json({
      ...row,
      images,
      cover_image: images[0] || null,
      image_files: next,
      filename,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/:hotelSlug/room-types/:id/images/:filename
router.delete('/:hotelSlug/room-types/:id/images/:filename', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const {
      normalizeStoredImages,
      deleteRoomTypeImageFile,
      resolveRoomTypeImages,
    } = require('../utils/roomTypeImages')

    const current = await pool.query(
      `SELECT * FROM room_types WHERE hotel_id = $1 AND id = $2`,
      [hotel.id, req.params.id]
    )
    if (!current.rows[0]) return res.status(404).json({ error: 'Room type not found' })

    const filename = String(req.params.filename || '')
    const stored = normalizeStoredImages(current.rows[0].images)
    if (!stored.includes(filename)) return res.status(404).json({ error: 'ไม่พบรูป' })

    await deleteRoomTypeImageFile(hotel.id, req.params.id, filename)
    const next = stored.filter((name) => name !== filename)
    const result = await pool.query(
      `UPDATE room_types SET images = $3::jsonb, updated_at = NOW()
       WHERE hotel_id = $1 AND id = $2 RETURNING *`,
      [hotel.id, req.params.id, JSON.stringify(next)]
    )
    const row = result.rows[0]
    const images = resolveRoomTypeImages(next, {
      slug: hotel.slug,
      roomTypeId: row.id,
      typeName: row.name,
    })
    res.json({
      ...row,
      images,
      cover_image: images[0] || null,
      image_files: next,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/:hotelSlug/room-types/:id
router.delete('/:hotelSlug/room-types/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const inUse = await pool.query(
      `SELECT COUNT(*)::int AS n FROM rooms WHERE hotel_id = $1 AND room_type_id = $2`,
      [hotel.id, req.params.id]
    )
    if (inUse.rows[0].n > 0) {
      return res.status(409).json({ error: 'ยังมีห้องที่ใช้ประเภทนี้ — ลบห้องก่อน' })
    }
    const result = await pool.query(
      `DELETE FROM room_types WHERE hotel_id = $1 AND id = $2 RETURNING id`,
      [hotel.id, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Room type not found' })
    res.json({ ok: true })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/:hotelSlug/rooms
router.get('/:hotelSlug/rooms', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const bangkokToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
    const result = await pool.query(
      `SELECT r.*, rt.name AS room_type_name, rt.price_per_night,
              EXISTS (
                SELECT 1
                FROM booking_rooms br
                JOIN bookings b ON b.id = br.booking_id
                WHERE br.room_id = r.id
                  AND b.hotel_id = r.hotel_id
                  AND b.check_in_date = $2::date
                  AND b.status IN ('confirmed', 'pending', 'awaiting_payment')
              ) AS arrival_today
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.hotel_id = $1 ORDER BY r.floor, r.room_number`,
      [hotel.id, bangkokToday]
    )
    res.json(result.rows.map((row) => ({
      ...row,
      arrival_today: row.arrival_today === true,
    })))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/:hotelSlug/rooms
router.post('/:hotelSlug/rooms', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const { room_number, floor, room_type_id, status = 'available' } = req.body
    const roomNo = String(room_number || '').trim()
    if (!roomNo || !room_type_id) return res.status(400).json({ error: 'room_number and room_type_id are required' })
    if (!/^[A-Za-z0-9][A-Za-z0-9\-]*$/.test(roomNo)) {
      return res.status(400).json({ error: 'เลขห้องใช้ได้เฉพาะตัวอักษร ตัวเลข และขีด เช่น 203 หรือ A101' })
    }
    const VALID_STATUS = ['available', 'maintenance', 'inactive']
    if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    const floorNum = floor === undefined || floor === null || floor === '' ? 1 : Number(floor)
    if (!Number.isFinite(floorNum) || floorNum < 0) return res.status(400).json({ error: 'Invalid floor' })

    const result = await pool.query(
      `INSERT INTO rooms (hotel_id, room_type_id, room_number, floor, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [hotel.id, room_type_id, roomNo, floorNum, status]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    if (err.code === '23505') return res.status(409).json({ error: 'เลขห้องนี้มีอยู่แล้ว' })
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/:hotelSlug/rooms/:id
router.patch('/:hotelSlug/rooms/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const { status, notes, room_number, floor, room_type_id } = req.body
    const VALID_STATUS = ['available', 'maintenance', 'inactive']
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const fields = ['updated_at = NOW()']
    const params = [hotel.id, req.params.id]
    if (status) { params.push(status); fields.push(`status = $${params.length}`) }
    if (notes !== undefined) { params.push(notes); fields.push(`notes = $${params.length}`) }
    if (room_number !== undefined) {
      const roomNo = String(room_number).trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9\-]*$/.test(roomNo)) {
        return res.status(400).json({ error: 'เลขห้องใช้ได้เฉพาะตัวอักษร ตัวเลข และขีด เช่น 203 หรือ A101' })
      }
      params.push(roomNo)
      fields.push(`room_number = $${params.length}`)
    }
    if (floor !== undefined && floor !== null && floor !== '') {
      const floorNum = Number(floor)
      if (!Number.isFinite(floorNum) || floorNum < 0) return res.status(400).json({ error: 'Invalid floor' })
      params.push(floorNum)
      fields.push(`floor = $${params.length}`)
    }
    if (room_type_id) { params.push(room_type_id); fields.push(`room_type_id = $${params.length}`) }

    const result = await pool.query(
      `UPDATE rooms SET ${fields.join(', ')} WHERE hotel_id = $1 AND id = $2 RETURNING *`,
      params
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Room not found' })
    res.json(result.rows[0])
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    if (err.code === '23505') return res.status(409).json({ error: 'เลขห้องนี้มีอยู่แล้ว' })
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/:hotelSlug/rooms/:id
router.delete('/:hotelSlug/rooms/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertLocalInventory(pool, hotel.id)

    const booked = await pool.query(
      `SELECT 1 FROM booking_rooms WHERE room_id = $1 LIMIT 1`,
      [req.params.id]
    )
    if (booked.rows[0]) {
      return res.status(409).json({ error: 'ห้องนี้เคยถูกใช้ในการจองแล้ว ไม่สามารถลบได้ — เปลี่ยนเป็นไม่ใช้งานแทน' })
    }
    const result = await pool.query(
      `DELETE FROM rooms WHERE hotel_id = $1 AND id = $2 RETURNING id`,
      [hotel.id, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Room not found' })
    res.json({ ok: true })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    if (err.code === '23503') return res.status(409).json({ error: 'ห้องนี้ถูกใช้ในการจองแล้ว ไม่สามารถลบได้' })
    res.status(500).json({ error: err.message })
  }
})

// ── room blocks ───────────────────────────────────────────────────────────────

// POST /api/admin/:hotelSlug/blocks
router.post('/:hotelSlug/blocks', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const { room_id, date_from, date_to, reason } = req.body
    if (!room_id || !date_from || !date_to) return res.status(400).json({ error: 'room_id, date_from, date_to are required' })

    const result = await pool.query(
      `INSERT INTO room_blocks (hotel_id, room_id, date_from, date_to, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [hotel.id, room_id, date_from, date_to, reason || null]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/:hotelSlug/blocks
router.get('/:hotelSlug/blocks', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `SELECT rb.*, r.room_number FROM room_blocks rb JOIN rooms r ON r.id = rb.room_id
       WHERE rb.hotel_id = $1 ORDER BY rb.date_from DESC`,
      [hotel.id]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/:hotelSlug/blocks/:id
router.delete('/:hotelSlug/blocks/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    await pool.query(`DELETE FROM room_blocks WHERE id = $1 AND hotel_id = $2`, [req.params.id, hotel.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── reviews moderation ────────────────────────────────────────────────────────

router.get('/:hotelSlug/reviews', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `SELECT r.*, u.name AS guest_name FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.hotel_id = $1 ORDER BY r.created_at DESC`,
      [hotel.id]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:hotelSlug/reviews/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const { is_visible } = req.body
    const result = await pool.query(
      `UPDATE reviews SET is_visible = $1, updated_at = NOW() WHERE id = $2 AND hotel_id = $3 RETURNING *`,
      [Boolean(is_visible), req.params.id, hotel.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Review not found' })
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:hotelSlug/reviews/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `DELETE FROM reviews WHERE id = $1 AND hotel_id = $2 RETURNING id, images`,
      [req.params.id, hotel.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Review not found' })

    const { deleteReviewImageFile } = require('../utils/reviewImages')
    const images = Array.isArray(result.rows[0].images) ? result.rows[0].images : []
    for (const name of images) {
      if (name) await deleteReviewImageFile(hotel.id, name).catch(() => null)
    }

    res.json({ ok: true, id: result.rows[0].id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── settings ──────────────────────────────────────────────────────────────────

router.get('/:hotelSlug/settings', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `SELECT setting_key, setting_value FROM hotel_settings WHERE hotel_id = $1`, [hotel.id]
    )
    const settings = {}
    for (const row of result.rows) settings[row.setting_key] = row.setting_value
    res.json(settings)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:hotelSlug/settings', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    if (typeof req.body !== 'object' || !req.body) return res.status(400).json({ error: 'Body must be an object' })
    await setHotelSettings(pool, hotel.id, req.body)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── chat notify settings ──────────────────────────────────────────────────────

// ── chat unread ───────────────────────────────────────────────────────────────

router.get('/:hotelSlug/chat/unread-count', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM chat_messages
       WHERE hotel_id = $1
         AND sender_role IN ('customer', 'system')
         AND read_at IS NULL`,
      [hotel.id]
    )
    res.json({ count: result.rows[0]?.count || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:hotelSlug/chat-notify', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await getChatNotifySettings(pool, hotel.id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:hotelSlug/chat-notify', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    res.json(await setChatNotifySettings(pool, hotel.id, req.body))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── coupon settings ───────────────────────────────────────────────────────────

router.get('/:hotelSlug/coupon-settings', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    const { getCouponSettings } = require('../utils/couponSettings')
    res.json(await getCouponSettings(pool, hotel.id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:hotelSlug/coupon-settings', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    if (!(await isHotelFeatureEnabled(pool, hotel.id, 'feat_coupons'))) {
      return res.status(403).json({ error: 'คูปองปิดใช้งานสำหรับโรงแรมนี้' })
    }
    res.json(await setCouponSettings(pool, hotel.id, req.body))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── hotel admins (สาขาที่ตนดูแลเท่านั้น) ─────────────────────────────────────

router.get('/:hotelSlug/admins', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertManagesHotel(pool, req.user.id, hotel.id)
    res.json(await listHotelAdmins(pool, hotel.id))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/:hotelSlug/admins', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertManagesHotel(pool, req.user.id, hotel.id)
    const admin = await withTransaction(async (client) => {
      await assertManagesHotel(client, req.user.id, hotel.id)
      return addHotelAdmin(client, {
        hotelId: hotel.id,
        name: req.body?.name,
        phone: req.body?.phone,
        login_id: req.body?.login_id || req.body?.phone,
        password: req.body?.password || req.body?.phone,
      })
    })
    res.status(201).json({ success: true, admin, message: `เพิ่มแอดมิน ${admin.name} แล้ว` })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.delete('/:hotelSlug/admins/:userId', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    await assertManagesHotel(pool, req.user.id, hotel.id)
    const actorIsSuperAdmin = await isSuperAdminUser(pool, req.user.id)
    await withTransaction(async (client) => {
      await removeHotelAdmin(client, {
        hotelId: hotel.id,
        userId: req.params.userId,
        actorIsSuperAdmin,
      })
    })
    res.json({ success: true })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── hotel info ────────────────────────────────────────────────────────────────

router.get('/:hotelSlug/info', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    const r = await pool.query(`SELECT ${HOTEL_RETURN} FROM hotels WHERE id = $1`, [hotel.id])
    res.json(shapeHotel(r.rows[0]))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:hotelSlug/info', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const patch = pickHotelFields(req.body)
    const fields  = []
    const params  = [hotel.id]
    for (const [key, value] of Object.entries(patch)) {
      params.push(value)
      fields.push(`${key} = $${params.length}`)
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' })
    fields.push('updated_at = NOW()')

    const r = await pool.query(
      `UPDATE hotels SET ${fields.join(', ')} WHERE id = $1 RETURNING ${HOTEL_RETURN}`, params
    )
    res.json(shapeHotel(r.rows[0]))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:hotelSlug/config', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    const info = await pool.query(`SELECT ${HOTEL_RETURN} FROM hotels WHERE id = $1`, [hotel.id])
    const settings = await getHotelSettings(pool, hotel.id, CONFIG_SETTING_KEYS)
    settings.cancellation_policy = normalizeCancellationPolicy(settings.cancellation_policy)
    const shaped = await shapeHotelWithCatalog(pool, info.rows[0])
    await attachHotelBranding(pool, shaped)
    await attachHotelTheme(pool, shaped)
    res.json({ hotel: shaped, settings })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:hotelSlug/config', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const hotelPatch = pickHotelFields(req.body)
    if (Object.prototype.hasOwnProperty.call(hotelPatch, 'location_type')) {
      const { resolveLocationType } = require('../utils/hotelCatalogOptions')
      hotelPatch.location_type = await resolveLocationType(pool, hotel.id, hotelPatch.location_type)
    }
    if (Object.prototype.hasOwnProperty.call(hotelPatch, 'map_url')) {
      const mapUrl = String(hotelPatch.map_url || '').trim()
      hotelPatch.map_url = mapUrl
      hotelPatch.map_embed_url = mapUrl ? (await resolveHotelMapEmbedUrl(mapUrl, '')) : ''
    }
    if (Object.keys(hotelPatch).length) {
      const fields = []
      const params = [hotel.id]
      for (const [key, value] of Object.entries(hotelPatch)) {
        params.push(value)
        fields.push(`${key} = $${params.length}`)
      }
      fields.push('updated_at = NOW()')
      await pool.query(`UPDATE hotels SET ${fields.join(', ')} WHERE id = $1`, params)
    }

    const settingsPatch = pickConfigSettings(req.body)
    if (!(await isHotelFeatureEnabled(pool, hotel.id, 'feat_coupons'))) {
      for (const key of COUPON_SETTING_KEYS) delete settingsPatch[key]
    }
    if (Object.keys(settingsPatch).length) {
      await setHotelSettings(pool, hotel.id, settingsPatch)
    }

    if (!Object.keys(hotelPatch).length && !Object.keys(settingsPatch).length) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const info = await pool.query(`SELECT ${HOTEL_RETURN} FROM hotels WHERE id = $1`, [hotel.id])
    const settings = await getHotelSettings(pool, hotel.id, CONFIG_SETTING_KEYS)
    settings.cancellation_policy = normalizeCancellationPolicy(settings.cancellation_policy)
    const shaped = await shapeHotelWithCatalog(pool, info.rows[0])
    applyBookingPolicies(shaped, {
      cancellation_policy: settings.cancellation_policy,
      non_smoking: settings.non_smoking,
      non_smoking_fine: settings.non_smoking_fine,
    })
    await attachHotelBranding(pool, shaped)
    await attachHotelTheme(pool, shaped)
    res.json({ hotel: shaped, settings })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:hotelSlug/ui-image', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    const result = await saveHotelUiImage(
      pool,
      hotel,
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

router.delete('/:hotelSlug/ui-image/:kind', requireHotelAdmin, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })
    const result = await removeHotelUiImage(pool, hotel, req.params.kind)
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── seasonal pricing ──────────────────────────────────────────────────────────

router.get('/:hotelSlug/prices', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const r = await pool.query(
      `SELECT rp.*, rt.name AS room_type_name FROM room_prices rp
       JOIN room_types rt ON rt.id = rp.room_type_id
       WHERE rt.hotel_id = $1 ORDER BY rp.date_from`,
      [hotel.id]
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:hotelSlug/prices', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const { room_type_id, date_from, date_to, price_per_night, label } = req.body
    if (!room_type_id || !date_from || !date_to || !price_per_night) {
      return res.status(400).json({ error: 'room_type_id, date_from, date_to, price_per_night are required' })
    }
    const r = await pool.query(
      `INSERT INTO room_prices (room_type_id, date_from, date_to, price_per_night, label)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [room_type_id, date_from, date_to, price_per_night, label || null]
    )
    res.status(201).json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:hotelSlug/prices/:id', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    await pool.query(
      `DELETE FROM room_prices rp USING room_types rt
       WHERE rp.id = $1 AND rp.room_type_id = rt.id AND rt.hotel_id = $2`,
      [req.params.id, hotel.id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── dashboard stats ───────────────────────────────────────────────────────────

router.get('/:hotelSlug/dashboard', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    await maybeSyncPmsStatuses(pool, hotel.id)

    const kioskSettings = await getHotelSettings(pool, hotel.id, [
      'kiosk_enabled',
    ])
    const pmsOn = kioskSettings.kiosk_enabled === 'true'
    const bangkokToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })

    const createdDaySql = `(created_at AT TIME ZONE 'Asia/Bangkok')::date`
    const cancelDaySql  = `(COALESCE(cancelled_at, updated_at) AT TIME ZONE 'Asia/Bangkok')::date`

    if (pmsOn) {
      const [todayBooked, todayCancelled] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS count FROM bookings
           WHERE hotel_id = $1 AND ${createdDaySql} = $2::date`,
          [hotel.id, bangkokToday]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count FROM bookings
           WHERE hotel_id = $1 AND status = 'cancelled'
             AND ${cancelDaySql} = $2::date`,
          [hotel.id, bangkokToday]
        ),
      ])
      return res.json({
        pms: true,
        calendar_today: bangkokToday,
        today: {
          booked:    todayBooked.rows[0]?.count    || 0,
          cancelled: todayCancelled.rows[0]?.count || 0,
        },
      })
    }

    const [todayCheckIns, todayCheckOuts, todayBooked, todayCancelled] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS count FROM bookings
         WHERE hotel_id = $1 AND check_in_date = $2::date AND status IN ('confirmed','pending')`,
        [hotel.id, bangkokToday]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM bookings
         WHERE hotel_id = $1 AND check_out_date = $2::date AND status = 'checked_in'`,
        [hotel.id, bangkokToday]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM bookings
         WHERE hotel_id = $1 AND ${createdDaySql} = $2::date`,
        [hotel.id, bangkokToday]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM bookings
         WHERE hotel_id = $1 AND status = 'cancelled' AND ${cancelDaySql} = $2::date`,
        [hotel.id, bangkokToday]
      ),
    ])

    res.json({
      pms: false,
      calendar_today: bangkokToday,
      today: {
        check_ins:  todayCheckIns.rows[0]?.count  || 0,
        check_outs: todayCheckOuts.rows[0]?.count || 0,
        booked:     todayBooked.rows[0]?.count    || 0,
        cancelled:  todayCancelled.rows[0]?.count || 0,
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── kiosk config ──────────────────────────────────────────────────────────────
// GET /api/admin/:hotelSlug/kiosk-config — อ่าน kiosk config
router.get('/:hotelSlug/kiosk-config', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const settings = await getHotelSettings(pool, hotel.id, [
      'kiosk_db_name',
      'kiosk_hotel_id',
      'kiosk_com_no',
      'kiosk_login_id',
      'kiosk_login_name',
      'kiosk_enabled',
    ])
    res.json({
      kiosk_db_name:    settings.kiosk_db_name    || '',
      kiosk_hotel_id:   settings.kiosk_hotel_id   || '',
      kiosk_com_no:     settings.kiosk_com_no     || '',
      kiosk_login_id:   settings.kiosk_login_id   || '',
      kiosk_login_name: settings.kiosk_login_name || '',
      kiosk_enabled:    settings.kiosk_enabled    || 'false',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/:hotelSlug/kiosk-config — บันทึก kiosk config
router.put('/:hotelSlug/kiosk-config', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const {
      kiosk_db_name, kiosk_hotel_id, kiosk_com_no,
      kiosk_login_id, kiosk_login_name, kiosk_enabled,
    } = req.body

    await setHotelSettings(pool, hotel.id, {
      ...(kiosk_db_name    !== undefined && { kiosk_db_name:    String(kiosk_db_name).trim() }),
      ...(kiosk_hotel_id   !== undefined && { kiosk_hotel_id:   String(kiosk_hotel_id).trim() }),
      ...(kiosk_com_no     !== undefined && { kiosk_com_no:     String(kiosk_com_no).trim() }),
      ...(kiosk_login_id   !== undefined && { kiosk_login_id:   String(kiosk_login_id).trim() }),
      ...(kiosk_login_name !== undefined && { kiosk_login_name: String(kiosk_login_name).trim() }),
      ...(kiosk_enabled    !== undefined && { kiosk_enabled:    kiosk_enabled ? 'true' : 'false' }),
    })

    const after = await getHotelSettings(pool, hotel.id, [
      'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id',
    ])
    if (after.kiosk_enabled === 'true' && after.kiosk_db_name && after.kiosk_hotel_id) {
      try {
        const { syncPmsRoomTypesToPg } = require('../utils/kioskVacantRooms')
        await syncPmsRoomTypesToPg(pool, hotel.id, {
          dbName: after.kiosk_db_name,
          hotelID: after.kiosk_hotel_id,
        })
      } catch (syncErr) {
        console.warn('[kiosk-config] PMS room-type sync skipped:', syncErr.message)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/:hotelSlug/kiosk-config/test — ทดสอบเชื่อมต่อ kiosk
router.post('/:hotelSlug/kiosk-config/test', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const settings = await getHotelSettings(pool, hotel.id, [
      'kiosk_db_name', 'kiosk_hotel_id', 'kiosk_com_no',
    ])

    const dbName  = settings.kiosk_db_name
    const hotelID = settings.kiosk_hotel_id
    const comNo   = settings.kiosk_com_no

    if (!dbName || !hotelID || !comNo) {
      return res.status(400).json({ error: 'กรุณาบันทึกตั้งค่า PMS ก่อนทดสอบ' })
    }

    // ทดสอบโดยดึงห้องว่างของวันนี้ (walk-in mode) จำกัดแค่ connect ได้
    const { getKioskVacantRoomNumbers } = require('../utils/kioskVacantRooms')
    const today    = new Date()
    const tomorrow = new Date(today.getTime() + 86400000)
    const rooms    = await getKioskVacantRoomNumbers({
      dbName, hotelID, comNo,
      startDate: today, endDate: tomorrow,
      filterVC: true,
    })

    res.json({ ok: true, vacant_rooms: rooms.size, message: `เชื่อมต่อสำเร็จ — พบห้องว่าง ${rooms.size} ห้อง` })
  } catch (err) {
    res.status(500).json({ error: `เชื่อมต่อไม่สำเร็จ: ${err.message}` })
  }
})

// GET /api/admin/:hotelSlug/kiosk-rooms — สถานะห้อง live จาก Kiosk (RmSetupNum)
router.get('/:hotelSlug/kiosk-rooms', requireHotelAdmin, async (req, res) => {
  try {
    const pool  = getPool()
    const hotel = await resolveHotel(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const settings = await getHotelSettings(pool, hotel.id, [
      'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id', 'kiosk_com_no',
    ])
    const enabled  = settings.kiosk_enabled === 'true'
    const dbName   = settings.kiosk_db_name
    const hotelID  = settings.kiosk_hotel_id

    if (!enabled || !dbName || !hotelID) {
      return res.json({ source: 'local', rooms: [], counts: {} })
    }

    const { getKioskRoomStatus } = require('../utils/kioskRoomStatus')
    const { rooms, counts } = await getKioskRoomStatus({ dbName, hotelID })
    res.json({ source: 'kiosk', fetched_at: new Date().toISOString(), rooms, counts })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.use('/:hotelSlug/channel', requireHotelAdmin, require('./channel'))

module.exports = router
