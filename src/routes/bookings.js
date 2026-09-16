const router = require('express').Router()
const auth   = require('../middleware/authMiddleware')
const { getPool, withTransaction } = require('../db/pool')
const { getUnpaidExpireSettings, isBookingExpired, computeExpiresAt } = require('../utils/unpaidExpire')
const { notifyAdminNewBookingChat, notifyBookingCancelledChat } = require('../utils/bookingChatNotify')
const { emitBookingChanged } = require('../utils/bookingEvents')
const {
  parseBase64Image, saveBookingPaymentSlip, deletePaymentSlipByBookingId,
  readBookingPaymentSlip, MIME_EXT: SLIP_MIME_EXT,
} = require('../utils/bookingPaymentSlips')
const { notifyAdminPaymentSlipChat } = require('../utils/bookingChatNotify')
const { getHotelSettings } = require('../utils/hotelSettings')
const { isHotelFeatureEnabled } = require('../utils/hotelFeatureFlags')
const { getHotelBookingPolicies, applyBookingPolicies } = require('../utils/bookingPolicies')
const { maybeSyncPmsStatuses, maybePushBookingToPms, maybeCancelBookingInPms } = require('../utils/kioskSaveBooking')
const { ROOM_HOLD_STATUS_SQL } = require('../utils/availableRooms')
const {
  buildGuestProfileDiffFromBooking,
  applyGuestProfileDiff,
} = require('../utils/guestProfile')

// ── helpers ───────────────────────────────────────────────────────────────────

async function resolveHotelBySlug(pool, slug) {
  const result = await pool.query(
    `SELECT id, slug, name FROM hotels WHERE slug = $1 AND is_active = true`,
    [slug]
  )
  return result.rows[0] || null
}

function calcNights(checkIn, checkOut) {
  const a = new Date(checkIn)
  const b = new Date(checkOut)
  return Math.round((b - a) / 86400000)
}

function clipText(value, max) {
  const s = String(value || '').trim()
  if (!s) return null
  return s.slice(0, max)
}

// ── list bookings (customer) ──────────────────────────────────────────────────

router.get('/my', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotelsResult = await pool.query(
      `SELECT DISTINCT hotel_id FROM bookings WHERE user_id = $1`,
      [req.user.id]
    )
    for (const row of hotelsResult.rows) {
      await maybeSyncPmsStatuses(pool, row.hotel_id)
    }

    const result = await pool.query(
      `SELECT b.id, b.check_in_date, b.check_out_date, b.num_adults, b.num_children,
              b.status, b.total_price, b.deposit_amount, b.special_requests,
              b.created_at, b.updated_at, b.cancelled_reason,
              b.pms_ota_booking_no, b.pms_resv_no, b.pms_room_no, b.hotel_id,
              b.include_breakfast, b.breakfast_count, b.rate_plan_id,
              h.slug AS hotel_slug, h.name AS hotel_name,
              rp.name AS rate_plan_name,
              (SELECT EXISTS (SELECT 1 FROM reviews rv WHERE rv.booking_id = b.id)) AS has_review,
              json_agg(json_build_object(
                'room_id', br.room_id, 'room_number', r.room_number, 'floor', r.floor,
                'room_type_name', rt.name, 'price_per_night', br.price_per_night,
                'nights', br.nights, 'subtotal', br.subtotal
              )) AS rooms
       FROM bookings b
       JOIN hotels h ON h.id = b.hotel_id
       LEFT JOIN rate_plans rp ON rp.id = b.rate_plan_id
       LEFT JOIN booking_rooms br ON br.booking_id = b.id
       LEFT JOIN rooms r ON r.id = br.room_id
       LEFT JOIN room_types rt ON rt.id = br.room_type_id
       WHERE b.user_id = $1
       GROUP BY b.id, h.slug, h.name, rp.name
       ORDER BY b.created_at DESC`,
      [req.user.id]
    )

    const policyByHotel = new Map()
    const rows = []
    for (const row of result.rows) {
      if (!policyByHotel.has(row.hotel_id)) {
        policyByHotel.set(row.hotel_id, await getHotelBookingPolicies(pool, row.hotel_id))
      }
      rows.push(applyBookingPolicies({ ...row }, policyByHotel.get(row.hotel_id)))
    }
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:hotelSlug/my', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    await maybeSyncPmsStatuses(pool, hotel.id)

    const result = await pool.query(
      `SELECT b.id, b.check_in_date, b.check_out_date, b.num_adults, b.num_children,
              b.status, b.total_price, b.deposit_amount, b.special_requests,
              b.created_at, b.updated_at, b.cancelled_reason,
              b.pms_ota_booking_no, b.pms_resv_no, b.pms_room_no,
              b.include_breakfast, b.breakfast_count, b.rate_plan_id,
              rp.name AS rate_plan_name,
              (SELECT EXISTS (SELECT 1 FROM reviews rv WHERE rv.booking_id = b.id)) AS has_review,
              json_agg(json_build_object(
                'room_id', br.room_id, 'room_number', r.room_number, 'floor', r.floor,
                'room_type_name', rt.name, 'price_per_night', br.price_per_night,
                'nights', br.nights, 'subtotal', br.subtotal
              )) AS rooms
       FROM bookings b
       LEFT JOIN rate_plans rp ON rp.id = b.rate_plan_id
       LEFT JOIN booking_rooms br ON br.booking_id = b.id
       LEFT JOIN rooms r ON r.id = br.room_id
       LEFT JOIN room_types rt ON rt.id = br.room_type_id
       WHERE b.hotel_id = $1 AND b.user_id = $2
       GROUP BY b.id, rp.name
       ORDER BY b.created_at DESC`,
      [hotel.id, req.user.id]
    )
    const policies = await getHotelBookingPolicies(pool, hotel.id)
    res.json(result.rows.map((row) => applyBookingPolicies(row, policies)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── get single booking ────────────────────────────────────────────────────────

router.get('/:hotelSlug/:bookingId', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    await maybeSyncPmsStatuses(pool, hotel.id)

    const result = await pool.query(
      `SELECT b.*,
              (SELECT status FROM booking_payment_slips WHERE booking_id = b.id LIMIT 1) AS slip_status,
              json_agg(json_build_object(
                'room_id', br.room_id, 'room_number', r.room_number, 'floor', r.floor,
                'room_type_name', rt.name, 'price_per_night', br.price_per_night,
                'nights', br.nights, 'subtotal', br.subtotal
              )) AS rooms
       FROM bookings b
       LEFT JOIN booking_rooms br ON br.booking_id = b.id
       LEFT JOIN rooms r ON r.id = br.room_id
       LEFT JOIN room_types rt ON rt.id = br.room_type_id
       WHERE b.id = $1 AND b.hotel_id = $2 AND b.user_id = $3
       GROUP BY b.id`,
      [req.params.bookingId, hotel.id, req.user.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Booking not found' })

    const booking = result.rows[0]
    applyBookingPolicies(booking, await getHotelBookingPolicies(pool, hotel.id))
    const { enabled, expireHours } = await getUnpaidExpireSettings(pool, hotel.id)
    booking.expires_at = booking.status === 'awaiting_payment'
      ? computeExpiresAt(booking.created_at, expireHours)
      : null
    res.json(booking)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── create booking ────────────────────────────────────────────────────────────

router.post('/:hotelSlug', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const {
      check_in_date, check_out_date,
      num_adults = 1, num_children = 0,
      room_type_id, special_requests,
      guest_name, guest_phone, guest_email,
      guest_title, guest_first_name, guest_last_name,
      guest_sex, guest_nation, guest_national_id, guest_passport,
      guest_birthday, guest_car_no,
      guest_address1, guest_address2, guest_address3,
      include_breakfast, breakfast_count, rate_plan_id,
    } = req.body

    if (!check_in_date || !check_out_date || !room_type_id) {
      return res.status(400).json({ error: 'check_in_date, check_out_date, room_type_id are required' })
    }
    if (!String(guest_title || '').trim() || !String(guest_sex || '').trim()
        || !String(guest_first_name || '').trim() || !String(guest_last_name || '').trim()) {
      return res.status(400).json({ error: 'กรอกคำนำหน้า เพศ ชื่อ และนามสกุล' })
    }
    if (check_out_date <= check_in_date) {
      return res.status(400).json({ error: 'check_out_date must be after check_in_date' })
    }

    const minCheckIn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
    if (check_in_date < minCheckIn) {
      return res.status(400).json({ error: 'วันเช็คอินต้องไม่น้อยกว่าวันนี้' })
    }

    const nights = calcNights(check_in_date, check_out_date)

    const booking = await withTransaction(async (client) => {
      // ดึงราคาห้อง
      const rtResult = await client.query(
        `SELECT id, name, price_per_night, max_adults, max_children
         FROM room_types WHERE id = $1 AND hotel_id = $2 AND is_active = true`,
        [room_type_id, hotel.id]
      )
      if (!rtResult.rows[0]) throw Object.assign(new Error('Room type not found or unavailable'), { status: 404 })
      const roomType = rtResult.rows[0]

      const { getChannelQuotes, quoteChannelStay, parseBreakfastChoice } = require('../utils/channelManager')
      const partySize = Math.max(1, Number(num_adults) + Number(num_children))
      let breakfastChoice = parseBreakfastChoice(include_breakfast, breakfast_count, partySize)

      const kioskCfg = await getHotelSettings(client, hotel.id, [
        'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id', 'kiosk_com_no',
      ])
      const pmsSellableOn = kioskCfg.kiosk_enabled === 'true'
        && Boolean(kioskCfg.kiosk_db_name && kioskCfg.kiosk_hotel_id && kioskCfg.kiosk_com_no)
      if (pmsSellableOn) {
        const { getKioskStaySellableByType } = require('../utils/kioskVacantRooms')
        const sellableMap = await getKioskStaySellableByType({
          dbName: kioskCfg.kiosk_db_name,
          hotelID: kioskCfg.kiosk_hotel_id,
          comNo: kioskCfg.kiosk_com_no,
          checkIn: check_in_date,
          checkOut: check_out_date,
        })
        const typeKey = String(roomType.name || '').trim().toUpperCase()
        let sellable
        for (const [name, count] of Object.entries(sellableMap || {})) {
          if (String(name || '').trim().toUpperCase() === typeKey) {
            sellable = Number(count)
            break
          }
        }
        if (Object.keys(sellableMap || {}).length) {
          if (!Number.isFinite(sellable) || sellable <= 0) {
            throw Object.assign(new Error('ไม่มีห้องว่างในช่วงวันที่เลือก'), { status: 409 })
          }
          const unpushed = await client.query(
            `SELECT COUNT(DISTINCT b.id)::int AS n
             FROM booking_rooms br
             JOIN bookings b ON b.id = br.booking_id
             WHERE b.hotel_id = $1 AND br.room_type_id = $2
               AND ${ROOM_HOLD_STATUS_SQL}
               AND b.check_in_date < $4 AND b.check_out_date > $3
               AND NULLIF(TRIM(COALESCE(b.pms_resv_no, '')), '') IS NULL`,
            [hotel.id, room_type_id, check_in_date, check_out_date]
          )
          if (unpushed.rows[0].n >= sellable) {
            throw Object.assign(new Error('ไม่มีห้องว่างในช่วงวันที่เลือก'), { status: 409 })
          }
        }
      }

      // จองล่วงหน้าโหมด PMS: ไม่ยึดเลขห้อง — นับโควตาจากประเภทเท่านั้น
      let roomId = null
      if (!pmsSellableOn) {
        const bookedResult = await client.query(
          `SELECT DISTINCT br.room_id FROM booking_rooms br
           JOIN bookings b ON b.id = br.booking_id
           WHERE b.hotel_id = $1 AND ${ROOM_HOLD_STATUS_SQL}
             AND b.check_in_date < $3 AND b.check_out_date > $2
             AND br.room_id IS NOT NULL`,
          [hotel.id, check_in_date, check_out_date]
        )
        const bookedIds = bookedResult.rows.map(r => r.room_id)

        const roomQuery = bookedIds.length > 0
          ? `SELECT id FROM rooms WHERE hotel_id = $1 AND room_type_id = $2 AND status = 'available'
             AND id NOT IN (${bookedIds.map((_, i) => `$${i + 3}`).join(',')}) LIMIT 1 FOR UPDATE SKIP LOCKED`
          : `SELECT id FROM rooms WHERE hotel_id = $1 AND room_type_id = $2 AND status = 'available' LIMIT 1 FOR UPDATE SKIP LOCKED`

        const roomResult = await client.query(roomQuery, [hotel.id, room_type_id, ...bookedIds])
        if (!roomResult.rows[0]) throw Object.assign(new Error('ไม่มีห้องว่างในช่วงวันที่เลือก'), { status: 409 })
        roomId = roomResult.rows[0].id
      }

      let pricePerNight = 0
      let abfPerPerson = 0
      let chosenRatePlanId = rate_plan_id || null

      const channelQuotes = await getChannelQuotes(client, hotel.id, room_type_id, check_in_date, check_out_date)
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

      const channelQuote = await quoteChannelStay(client, hotel.id, room_type_id, check_in_date, check_out_date, {
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
      pricePerNight = channelQuote.roomAvg
      abfPerPerson = channelQuote.includes_breakfast ? channelQuote.abfAvg : 0
      breakfastChoice = {
        includeBreakfast: channelQuote.includes_breakfast,
        breakfastCount: channelQuote.breakfast_count,
      }

      const abfTotal = breakfastChoice.includeBreakfast
        ? abfPerPerson * breakfastChoice.breakfastCount * nights
        : 0
      const subtotal = channelQuote.total

      const payEnabled = await isHotelFeatureEnabled(client, hotel.id, 'feat_payment_slip')
      const settings = await getHotelSettings(client, hotel.id, [
        'deposit_percent', 'payment_collect_mode', 'kiosk_enabled',
        'service_charge_percent', 'vat_percent',
      ])
      const collectFull = settings.payment_collect_mode === 'full'
      const { applyStayCharges } = require('../utils/stayCharges')
      const charged = applyStayCharges(subtotal, {
        collectFull,
        serviceChargePercent: settings.service_charge_percent,
        vatPercent: settings.vat_percent,
      })
      const payable = charged.total
      let depositPercent = collectFull ? 100 : Number(settings.deposit_percent)
      if (!Number.isFinite(depositPercent) || depositPercent < 0) depositPercent = 30
      if (depositPercent > 100) depositPercent = 100

      const depositAmount = payEnabled ? Math.ceil(payable * (depositPercent / 100)) : 0
      const pmsOn = settings.kiosk_enabled === 'true'
      const bookingStatus = payEnabled && depositAmount > 0
        ? 'awaiting_payment'
        : (pmsOn ? 'pending' : 'confirmed')

      const fullGuestName = [
        guest_title, guest_first_name, guest_last_name,
      ].filter(Boolean).join(' ').trim() || guest_name || null

      const bResult = await client.query(
        `INSERT INTO bookings
           (hotel_id, user_id, check_in_date, check_out_date, num_adults, num_children,
            status, total_price, deposit_amount, special_requests,
            guest_name, guest_phone, guest_email,
            guest_title, guest_first_name, guest_last_name, guest_sex, guest_nation,
            guest_national_id, guest_passport, guest_birthday, guest_car_no,
            guest_address1, guest_address2, guest_address3,
            include_breakfast, breakfast_count, rate_plan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
         RETURNING *`,
        [
          hotel.id, req.user.id, check_in_date, check_out_date,
          num_adults, num_children, bookingStatus, payable, depositAmount,
          special_requests || null,
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

      // สร้าง booking_rooms
      await client.query(
        `INSERT INTO booking_rooms (booking_id, room_id, room_type_id, price_per_night, nights, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newBooking.id, roomId, room_type_id, pricePerNight, nights, subtotal]
      )

      // อัปเดตโปรไฟล์ผู้ใช้จากฟอร์มจอง (เฉพาะฟิลด์ว่างหรือต่างจากเดิม)
      const userRow = await client.query(
        `SELECT id, name, email,
                guest_title, guest_first_name, guest_last_name, guest_sex, guest_nation,
                guest_national_id, guest_passport, guest_birthday, guest_phone, guest_car_no,
                guest_address1, guest_address2, guest_address3, guest_special_requests
           FROM users WHERE id = $1`,
        [req.user.id]
      )
      const profileDiff = buildGuestProfileDiffFromBooking(userRow.rows[0] || {}, {
        guest_title, guest_first_name, guest_last_name,
        guest_sex, guest_nation, guest_national_id, guest_passport,
        guest_birthday, guest_phone, guest_email, guest_car_no,
        guest_address1, guest_address2, guest_address3,
        special_requests,
      })
      await applyGuestProfileDiff(client, req.user.id, profileDiff)

      return newBooking
    })

    notifyAdminNewBookingChat(pool, hotel.id, booking.id).catch(() => null)
    emitBookingChanged(hotel.id, { type: 'created', booking_id: booking.id })

    let pms = null
    const kioskAfter = await getHotelSettings(pool, hotel.id, ['kiosk_enabled'])
    if (kioskAfter.kiosk_enabled === 'true') {
      pms = await maybePushBookingToPms(pool, hotel.id, booking.id)
      if (pms?.newResvNo || pms?.sent) {
        const refreshed = await pool.query(`SELECT * FROM bookings WHERE id = $1 AND hotel_id = $2`, [booking.id, hotel.id])
        if (refreshed.rows[0]) Object.assign(booking, refreshed.rows[0])
      }
    }

    res.status(201).json({ ...booking, pms })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── cancel booking (customer) ─────────────────────────────────────────────────

router.patch('/:hotelSlug/:bookingId/cancel', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const current = await pool.query(
      `SELECT id, status, pms_resv_no FROM bookings
       WHERE id = $1 AND hotel_id = $2 AND user_id = $3`,
      [req.params.bookingId, hotel.id, req.user.id]
    )
    const existing = current.rows[0]
    if (!existing) return res.status(404).json({ error: 'Booking not found' })
    if (!['awaiting_payment', 'pending'].includes(existing.status)) {
      return res.status(400).json({ error: 'Booking not found or cannot be cancelled' })
    }

    const pms = existing.pms_resv_no
      ? await maybeCancelBookingInPms(pool, hotel.id, req.params.bookingId)
      : { skipped: true }
    if (pms?.error) {
      return res.status(502).json({ error: `ยกเลิกใน PMS ไม่สำเร็จ: ${pms.error}`, pms })
    }

    const result = await pool.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_by = 'user',
              cancelled_reason = $3, cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND hotel_id = $2 AND user_id = $4
         AND status IN ('awaiting_payment', 'pending')
       RETURNING *`,
      [req.params.bookingId, hotel.id, req.body.reason || null, req.user.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Booking not found or cannot be cancelled' })

    await deletePaymentSlipByBookingId(pool, req.params.bookingId).catch(() => null)
    notifyBookingCancelledChat(pool, hotel.id, req.params.bookingId).catch(() => null)
    emitBookingChanged(hotel.id, { type: 'cancelled', booking_id: req.params.bookingId })

    res.json({ ...result.rows[0], pms })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── upload payment slip ───────────────────────────────────────────────────────

router.post('/:hotelSlug/:bookingId/slip', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const bResult = await pool.query(
      `SELECT id, status FROM bookings WHERE id = $1 AND hotel_id = $2 AND user_id = $3`,
      [req.params.bookingId, hotel.id, req.user.id]
    )
    const booking = bResult.rows[0]
    if (!booking) return res.status(404).json({ error: 'Booking not found' })
    if (booking.status !== 'awaiting_payment') {
      return res.status(400).json({ error: 'Only awaiting_payment bookings can upload a slip' })
    }

    const { imageData, imageMime } = req.body
    if (!imageData) return res.status(400).json({ error: 'imageData is required' })

    const parsed = parseBase64Image(imageData, imageMime)
    if (parsed?.error) return res.status(400).json({ error: parsed.error })

    const filename = await saveBookingPaymentSlip(req.params.bookingId, parsed.buffer, parsed.ext)

    await pool.query(
      `INSERT INTO booking_payment_slips (booking_id, hotel_id, slip_filename, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (booking_id) DO UPDATE SET slip_filename = $3, status = 'pending', updated_at = NOW()`,
      [req.params.bookingId, hotel.id, filename, req.user.id]
    )

    notifyAdminPaymentSlipChat(pool, hotel.id, req.params.bookingId).catch(() => null)
    emitBookingChanged(hotel.id, { type: 'slip_uploaded', booking_id: req.params.bookingId })

    res.json({ ok: true, filename })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── get payment slip image ────────────────────────────────────────────────────

router.get('/:hotelSlug/:bookingId/slip', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' })

    const slipResult = await pool.query(
      `SELECT bps.slip_filename FROM booking_payment_slips bps
       JOIN bookings b ON b.id = bps.booking_id
       WHERE bps.booking_id = $1 AND b.hotel_id = $2 AND b.user_id = $3`,
      [req.params.bookingId, hotel.id, req.user.id]
    )
    if (!slipResult.rows[0]) return res.status(404).json({ error: 'Slip not found' })

    const { buffer, ext } = await readBookingPaymentSlip(slipResult.rows[0].slip_filename)
    const mime = SLIP_MIME_EXT[ext] || 'application/octet-stream'
    res.set('Content-Type', mime).send(buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── SSE: real-time booking updates ───────────────────────────────────────────

router.get('/:hotelSlug/events', auth, async (req, res) => {
  try {
    const pool = getPool()
    const hotel = await resolveHotelBySlug(pool, req.params.hotelSlug)
    if (!hotel) return res.status(404).end()

    res.set({
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    res.flushHeaders()

    const { subscribeBookingEvents } = require('../utils/bookingEvents')
    const unsubscribe = subscribeBookingEvents(hotel.id, (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    })

    req.on('close', unsubscribe)
  } catch (err) {
    res.status(500).end()
  }
})

module.exports = router
