/**
 * ส่งการจองไป PMS เทียบ /api/kiosksavebooking (Sp_ReservationAppend)
 */
const { sql, connectDynamicDB } = require('../db/mssql')
const { getHotelSettings } = require('./hotelSettings')

function ymd(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  try {
    return value.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  } catch {
    return ''
  }
}

/**
 * วันปฏิทินสำหรับ PMS (ArrivalDate / DeptDate / …)
 * PMS เก็บ DateTime ที่ 00:00:00.000 ของวันนั้น ไม่มี timezone
 * ห้ามใช้ T00:00:00+07:00 — tedious จะเขียนเป็น UTC วันก่อน 17:00:00
 */
function asDate(value) {
  if (!value) return null
  const day = ymd(value)
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  if (![y, m, d].every((n) => Number.isFinite(n))) return null
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
}

function parseTimeString(timeString) {
  if (!timeString || !String(timeString).trim()) return null
  const parts = String(timeString).trim().split(':')
  const hours = parseInt(parts[0], 10)
  const minutes = parseInt(parts[1] || '0', 10)
  const seconds = parseInt(parts[2] || '0', 10)
  if ([hours, minutes, seconds].some((n) => Number.isNaN(n))) return null
  if (hours < 0 || hours > 23 || minutes > 59 || seconds > 59) return null
  return new Date(Date.UTC(1899, 11, 30, hours, minutes, seconds))
}

function clip(value, max) {
  const s = String(value || '').trim()
  return s ? s.slice(0, max) : ''
}

function normRoom(value) {
  return String(value || '').trim().toUpperCase()
}

async function pickPmsRoomNo({ settings, payload }) {
  const preferred = clip(payload.RoomNo, 7)
  const roomType = String(payload.RoomType || '').trim()
  let vacant = []
  try {
    const { getKioskVacantRooms } = require('./kioskVacantRooms')
    vacant = await getKioskVacantRooms({
      dbName: settings.kiosk_db_name,
      hotelID: settings.kiosk_hotel_id,
      comNo: settings.kiosk_com_no,
      startDate: `${ymd(payload.ArrivalDate)}T00:00:00+07:00`,
      endDate: `${ymd(payload.DeptDate)}T00:00:00+07:00`,
      filterVC: true,
    })
  } catch (err) {
    console.warn('[pms] vacant rooms failed:', err.message)
  }

  const ofType = vacant.filter((r) => !roomType || normRoom(r.room_type) === normRoom(roomType))
  const pool = ofType.length ? ofType : vacant
  const match = pool.find((r) => normRoom(r.room_number) === normRoom(preferred))
  if (match) return clip(match.room_number, 7)
  if (pool[0]?.room_number) return clip(pool[0].room_number, 7)
  if (preferred) return preferred
  throw new Error('ไม่มีห้องว่างใน PMS สำหรับประเภทห้องและวันที่ที่เลือก')
}

function guestOtaBookingNo(bookingId) {
  const hex = String(bookingId || '').replace(/-/g, '') || '1'
  const n = BigInt(`0x${hex.slice(0, 13)}`) % 9000000000n + 1000000000n
  return String(n)
}

/** เทียบ GET /api/kioskbooking/:resvNo */
async function fetchKioskBookingByResvNo({ dbName, resvNo }) {
  const resvNoInt = Number(resvNo)
  if (!Number.isInteger(resvNoInt) || resvNoInt <= 0) return null
  const pool = await connectDynamicDB(dbName)
  try {
    const result = await pool.request()
      .input('resvNo', sql.Int, resvNoInt)
      .query(`
        SELECT TOP 1
               r.ResvNo,
               r.RoomNo,
               r.OTABookingNo
        FROM Reservation r
        WHERE r.ResvNo = @resvNo
          AND r.RoomCount = 1
          AND r.Status <> 'CO'
      `)
    return result.recordset?.[0] || null
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function readOtaBookingNo({ dbName, resvNo, fallback }) {
  try {
    const reservation = await fetchKioskBookingByResvNo({ dbName, resvNo })
    const fromPms = clip(reservation?.OTABookingNo, 20)
    if (fromPms) return fromPms
  } catch (err) {
    console.warn('[pms] kioskbooking fetch failed:', err.message)
  }
  return clip(fallback, 20) || ''
}

async function saveKioskBookingToPms({ settings, payload, assignRoom = true }) {
  const dbName  = settings.kiosk_db_name
  const hotelID = settings.kiosk_hotel_id
  const comNo   = settings.kiosk_com_no
  const loginID = String(settings.kiosk_login_id || '').trim()

  if (!dbName || !hotelID || !comNo) {
    throw new Error('ยังตั้งค่า PMS ไม่ครบ (dbName, hotelID, comNo)')
  }
  if (!loginID) throw new Error('ยังไม่ได้ตั้ง Login ID ของ PMS')

  const adultCount = Math.max(1, parseInt(payload.GstAdult, 10) || 1)
  if (!payload.ArrivalDate || !payload.DeptDate || !payload.RoomType) {
    throw new Error('ข้อมูลวันเข้าพักหรือประเภทห้องไม่ครบ')
  }
  // จองล่วงหน้า: บันทึกแค่ประเภทห้อง ไม่ยึดเลขห้อง — โรงแรมจัดห้องตอนเช็คอิน
  const assignedRoomNo = assignRoom
    ? await pickPmsRoomNo({ settings, payload })
    : clip(payload.RoomNo, 7)

  const pool = await connectDynamicDB(dbName)
  const transaction = new sql.Transaction(pool)
  try {
    await transaction.begin()

    const defaultOptionResult = await new sql.Request(transaction).query(`
      SELECT TOP 1 GstTypeDef, GstLevelDef, BusSourceDef, MarketDef, Def_TimeCheckOut
      FROM FRONT_OPTION
    `)
    const defaultOptions = defaultOptionResult.recordset[0] || {}

    const seqResult = await new sql.Request(transaction).execute('Sp_GuestSequentUpdate')
    const newResvNo = seqResult.returnValue
    if (!newResvNo) {
      await transaction.rollback()
      throw new Error('สร้าง ResvNo จาก PMS ไม่สำเร็จ')
    }

    const arrivalTimeParam = new Date(Date.now() + 7 * 60 * 60 * 1000)
    const deptTimeParam = parseTimeString(defaultOptions.Def_TimeCheckOut)
    const resvDate = asDate(payload.ResvDate) || new Date()
    const arrivalDate = asDate(payload.ArrivalDate)
    const deptDate = asDate(payload.DeptDate)
    const birthday = asDate(payload.Birthday)
    const resvName = `${payload.GstFName || ''} ${payload.GstLName || ''}`.trim()

    for (let i = 1; i <= adultCount; i++) {
      const gstNo = i
      const roomCount = i === 1 ? 1 : 0
      const request = new sql.Request(transaction)
      request
        .input('RecState', sql.Int, 1)
        .input('ResvNo', sql.Int, newResvNo)
        .input('GstNo', sql.Int, gstNo)
        .input('ResvDate', sql.DateTime, resvDate)
        .input('GstFName', sql.VarChar(30), clip(payload.GstFName, 30))
        .input('GstLName', sql.VarChar(30), clip(payload.GstLName, 30))
        .input('GStTitle', sql.VarChar(16), clip(payload.GstTitle, 16))
        .input('GstNation', sql.VarChar(3), clip(payload.GstNation, 3))
        .input('GstAgent', sql.VarChar(10), 'BookEng')
        .input('GstType', sql.VarChar(3), defaultOptions.GstTypeDef || '')
        .input('GstLevel', sql.VarChar(3), defaultOptions.GstLevelDef || '')
        .input('GstBusSource', sql.VarChar(5), defaultOptions.BusSourceDef || '')
        .input('GstMarketCode', sql.VarChar(5), defaultOptions.MarketDef || '')
        .input('ResvType', sql.VarChar(3), ' ')
        .input('ResvStatus', sql.VarChar(3), 'CFM')
        .input('GstAdult', sql.Int, adultCount)
        .input('GstChildren', sql.SmallInt, Number(payload.GstChildren) || 0)
        .input('StayDay', sql.SmallInt, Number(payload.nights) || 0)
        .input('ArrivalDate', sql.DateTime, arrivalDate)
        .input('ArrivalTime', sql.DateTime, arrivalTimeParam)
        .input('ArrivalBy', sql.VarChar(2), ' ')
        .input('ArrivalFlgDetail', sql.VarChar(10), ' ')
        .input('ArrServiceBy', sql.VarChar(3), ' ')
        .input('DeptDate', sql.DateTime, deptDate)
        .input('DeptTime', sql.DateTime, deptTimeParam)
        .input('DeptBy', sql.VarChar(2), ' ')
        .input('DeptFlgDetail', sql.VarChar(10), ' ')
        .input('DeptServiceBy', sql.VarChar(3), ' ')
        .input('RoomCount', sql.SmallInt, roomCount)
        .input('RoomType', sql.VarChar(5), clip(payload.RoomType, 5))
        .input('RoomRateCode', sql.VarChar(7), ' ')
        .input('RoomRateAmt', sql.Float, Number(payload.RoomRateAmt) || 0)
        .input('RoomFeature', sql.VarChar(20), '')
        .input('RoomNo', sql.VarChar(7), assignedRoomNo || ' ')
        .input('DepositAmt', sql.Float, 0)
        .input('PaymentType', sql.VarChar(5), '')
        .input('CreditLimit', sql.Float, 0)
        .input('Reference', sql.VarChar(40), '')
        .input('CardApprove', sql.VarChar(10), ' ')
        .input('CardExpire', sql.DateTime, null)
        .input('GstHistory', sql.VarChar(1), 'Y')
        .input('Comp', sql.VarChar(1), 'N')
        .input('Memo1', sql.VarChar(255), clip(payload.Memo1, 255))
        .input('Memo2', sql.VarChar(255), '')
        .input('User', sql.VarChar(20), clip(loginID, 20))
        .input('Date', sql.DateTime, new Date())
        .input('ResvName', sql.VarChar(48), clip(resvName, 48))
        .input('GstPassPortNo', sql.VarChar(30), clip(payload.GstPassPortNo, 30))
        .input('yyyyBirthday', sql.VarChar(4), ' ')
        .input('Sex', sql.VarChar(8), clip(payload.Sex, 8))
        .input('Visa', sql.VarChar(32), ' ')
        .input('visaBgDate', sql.DateTime, null)
        .input('visaenddate', sql.DateTime, null)
        .input('tmno', sql.VarChar(32), ' ')
        .input('PointOfEntry', sql.VarChar(10), ' ')
        .input('add1', sql.VarChar(64), '')
        .input('add2', sql.VarChar(64), '')
        .input('add3', sql.VarChar(64), '')
        .input('AbfAmt', sql.Float, Number(payload.AbfAmt) || 0)
        .input('ExtraBed', sql.Float, 0)
        .input('Telno', sql.VarChar(24), clip(payload.TelNo, 24))
        .input('Email', sql.VarChar(64), clip(payload.Email, 64))
        .input('Company', sql.VarChar(100), '')
        .input('Birthday', sql.DateTime, birthday)
        .input('Chargeto', sql.VarChar(32), 'A/C Guest')
        .input('PrnRate', sql.VarChar(1), 'N')
        .input('ArrCount', sql.Int, 1)
        .input('AmtUsed', sql.Float, 0)
        .input('Memo3', sql.VarChar(255), '')
        .input('AuthAmt', sql.Float, 0)
        .input('AuthPaidBy', sql.VarChar(5), ' ')
        .input('AuthRef', sql.VarChar(32), ' ')
        .input('GstPictName', sql.VarChar(32), '')
        .input('RegistNo', sql.VarChar(10), ' ')
        .input('HomeAdd1', sql.VarChar(64), clip(payload.HomeAddress1, 60))
        .input('HomeAdd2', sql.VarChar(64), clip(payload.HomeAddress2, 60))
        .input('HomeAdd3', sql.VarChar(64), clip(payload.HomeAddress3, 60))
        .input('FolioPrintNo', sql.SmallInt, 1)
        .input('SaleID', sql.VarChar(20), ' ')
        .input('Rackrate', sql.Float, 0)
        .input('DiscPecent', sql.Int, 0)
        .input('DiscBaht', sql.Float, 0)
        .input('AbfAdult', sql.Int, Number(payload.AbfAdult) || 0)
        .input('AbfChildAmt', sql.Float, 0)
        .input('ExtraBedCount', sql.Int, 0)
        .input('BabyCotCount', sql.SmallInt, 0)
        .input('BabyCotAmt', sql.Float, 0)
        .input('ExtraBedAbfAmt', sql.Float, 0)
        .input('BabyCotAbfAmt', sql.Float, 0)
        .input('ShiftNo', sql.SmallInt, 1)
        .input('TaxId', sql.VarChar(32), '')
        .input('CarId', sql.VarChar(16), clip(payload.CarNo, 16))
        .input('VoucherNo', sql.VarChar(25), '')
        .input('DepositKeyAmt', sql.Float, 0)
        .input('NationCardID', sql.VarChar(16), clip(payload.NationCardId, 16))
        .input('HotelId', sql.Int, parseInt(hotelID, 10))
        .input('FileImage', sql.VarChar(50), '')
        .input('QtyAbfChild', sql.SmallInt, 0)
        .input('OTABookingNo', sql.VarChar(20), clip(payload.OTABookingNo, 20))

      await request.execute('Sp_ReservationAppend')
    }

    await transaction.commit()
    const otaBookingNo = await readOtaBookingNo({
      dbName,
      resvNo: newResvNo,
      fallback: payload.OTABookingNo,
    })
    return { newResvNo, roomNo: assignedRoomNo || null, totalGuests: adultCount, otaBookingNo }
  } catch (err) {
    try { await transaction.rollback() } catch { /* ignore */ }
    throw err
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function pushBookingToPms(pg, hotelId, bookingId) {
  const settings = await getHotelSettings(pg, hotelId, [
    'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id', 'kiosk_com_no',
    'kiosk_login_id', 'kiosk_login_name',
  ])
  if (settings.kiosk_enabled !== 'true') return { skipped: true }

  const bookingResult = await pg.query(
    `SELECT b.*,
            br.price_per_night, br.nights, br.room_type_id,
            r.room_number,
            rt.name AS room_type_name
     FROM bookings b
     LEFT JOIN booking_rooms br ON br.booking_id = b.id
     LEFT JOIN rooms r ON r.id = br.room_id
     LEFT JOIN room_types rt ON rt.id = br.room_type_id
     WHERE b.id = $1 AND b.hotel_id = $2
     LIMIT 1`,
    [bookingId, hotelId]
  )
  const row = bookingResult.rows[0]
  if (!row) throw new Error('ไม่พบการจอง')
  if (row.pms_resv_no) {
    let otaBookingNo = clip(row.pms_ota_booking_no, 20)
    if (!otaBookingNo) {
      otaBookingNo = await readOtaBookingNo({
        dbName: settings.kiosk_db_name,
        resvNo: row.pms_resv_no,
        fallback: guestOtaBookingNo(row.id),
      })
      if (otaBookingNo) {
        await pg.query(
          `UPDATE bookings SET pms_ota_booking_no = $3, updated_at = NOW() WHERE id = $1 AND hotel_id = $2`,
          [bookingId, hotelId, otaBookingNo]
        )
      }
    }
    return {
      skipped: true,
      newResvNo: row.pms_resv_no,
      roomNo: row.pms_room_no,
      otaBookingNo: otaBookingNo || null,
    }
  }

  const nights = Number(row.nights) || Math.max(1, Math.round(
    (new Date(ymd(row.check_out_date)) - new Date(ymd(row.check_in_date))) / 86400000
  ))

  let roomRateAmt = Number(row.price_per_night) || 0
  let abfAmt = 0
  let abfAdult = 0
  try {
    const { quoteChannelStay } = require('./channelManager')
    const channelQuote = await quoteChannelStay(
      pg,
      hotelId,
      row.room_type_id,
      ymd(row.check_in_date),
      ymd(row.check_out_date),
      {
        rate_plan_id: row.rate_plan_id,
        includeBreakfast: row.include_breakfast,
        breakfastCount: row.breakfast_count,
        partySize: (Number(row.num_adults) || 0) + (Number(row.num_children) || 0),
      },
    )
    if (channelQuote) {
      roomRateAmt = Number(channelQuote.roomAvg) || roomRateAmt
      abfAmt = channelQuote.includes_breakfast ? Number(channelQuote.abfAvg) || 0 : 0
      abfAdult = channelQuote.includes_breakfast ? Number(channelQuote.breakfast_count) || 0 : 0
    } else if (row.include_breakfast) {
      abfAmt = 0
      abfAdult = 0
    }
  } catch (rateErr) {
    console.warn('[pms] channel rate lookup failed:', rateErr.message)
  }

  const payload = {
    ResvDate: ymd(new Date()),
    ArrivalDate: ymd(row.check_in_date),
    DeptDate: ymd(row.check_out_date),
    GstAdult: row.num_adults,
    GstChildren: row.num_children,
    nights,
    RoomType: row.room_type_name,
    RoomNo: '',
    RoomRateAmt: roomRateAmt,
    AbfAdult: abfAdult,
    AbfAmt: abfAmt,
    GstTitle: row.guest_title,
    Sex: row.guest_sex,
    GstFName: row.guest_first_name,
    GstLName: row.guest_last_name,
    Birthday: row.guest_birthday,
    NationCardId: row.guest_national_id,
    GstPassPortNo: row.guest_passport,
    GstNation: row.guest_nation,
    TelNo: row.guest_phone,
    Email: row.guest_email,
    HomeAddress1: row.guest_address1,
    HomeAddress2: row.guest_address2,
    HomeAddress3: row.guest_address3,
    CarNo: row.guest_car_no,
    Memo1: row.special_requests,
    OTABookingNo: guestOtaBookingNo(row.id),
  }

  try {
    const result = await saveKioskBookingToPms({ settings, payload, assignRoom: false })
    await pg.query(
      `UPDATE bookings
       SET pms_resv_no = $3, pms_room_no = $4, pms_ota_booking_no = $5,
           pms_sent_at = NOW(), pms_last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND hotel_id = $2`,
      [bookingId, hotelId, String(result.newResvNo), result.roomNo || null, result.otaBookingNo || guestOtaBookingNo(row.id)]
    )
    return result
  } catch (err) {
    await pg.query(
      `UPDATE bookings SET pms_last_error = $3, updated_at = NOW() WHERE id = $1 AND hotel_id = $2`,
      [bookingId, hotelId, String(err.message || 'ส่ง PMS ไม่สำเร็จ').slice(0, 500)]
    )
    throw err
  }
}

function emptyPmsSyncResult() {
  return { cancelledIds: [], checkedInIds: [], checkedOutIds: [] }
}

function trimPmsCode(value) {
  return String(value || '').trim().toUpperCase()
}

/** ดึง ResvStatus / Status จาก PMS ตาม ResvNo ที่เว็บมี */
async function fetchPmsReservationStates({ dbName, resvNos }) {
  const ids = [...new Set(
    (resvNos || []).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0)
  )]
  const states = new Map()
  if (!ids.length) return states

  const pool = await connectDynamicDB(dbName)
  try {
    const request = pool.request()
    const placeholders = ids.map((id, i) => {
      request.input(`r${i}`, sql.Int, id)
      return `@r${i}`
    })
    const result = await request.query(`
      SELECT r.ResvNo,
             LTRIM(RTRIM(r.ResvStatus)) AS ResvStatus,
             LTRIM(RTRIM(r.Status)) AS Status
      FROM Reservation r
      WHERE r.ResvNo IN (${placeholders.join(', ')})
    `)
    for (const row of result.recordset || []) {
      const resvNo = Number(row.ResvNo)
      const prev = states.get(resvNo) || { cxl: false, ci: false, co: false }
      if (trimPmsCode(row.ResvStatus) === 'CXL') prev.cxl = true
      if (trimPmsCode(row.Status) === 'CI') prev.ci = true
      if (trimPmsCode(row.Status) === 'CO') prev.co = true
      states.set(resvNo, prev)
    }
    return states
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function syncPmsStatuses(pg, hotelId) {
  const settings = await getHotelSettings(pg, hotelId, [
    'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id',
  ])
  if (settings.kiosk_enabled !== 'true' || !settings.kiosk_db_name) return emptyPmsSyncResult()

  const local = await pg.query(
    `SELECT id, pms_resv_no, status FROM bookings
     WHERE hotel_id = $1
       AND NULLIF(TRIM(pms_resv_no), '') IS NOT NULL
       AND status <> 'cancelled'`,
    [hotelId]
  )
  if (!local.rows.length) return emptyPmsSyncResult()

  const states = await fetchPmsReservationStates({
    dbName: settings.kiosk_db_name,
    resvNos: local.rows.map((row) => row.pms_resv_no),
  })
  if (!states.size) return emptyPmsSyncResult()

  const cancelledIds = []
  const checkedInIds = []
  const checkedOutIds = []
  const alreadyTerminal = new Set(['checked_in', 'checked_out'])

  for (const row of local.rows) {
    const pms = states.get(parseInt(row.pms_resv_no, 10))
    if (!pms) continue

    if (pms.cxl) {
      const updated = await pg.query(
        `UPDATE bookings
         SET status = 'cancelled', cancelled_by = 'system',
             cancelled_reason = 'ยกเลิกจาก PMS', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND hotel_id = $2 AND status <> 'cancelled'
         RETURNING id`,
        [row.id, hotelId]
      )
      if (updated.rows[0]) cancelledIds.push(row.id)
      continue
    }

    if (pms.co && row.status !== 'checked_out') {
      const updated = await pg.query(
        `UPDATE bookings
         SET status = 'checked_out', updated_at = NOW()
         WHERE id = $1 AND hotel_id = $2
           AND status NOT IN ('cancelled', 'checked_out')
         RETURNING id, user_id`,
        [row.id, hotelId]
      )
      if (updated.rows[0]) {
        checkedOutIds.push(row.id)
        if (updated.rows[0].user_id) {
          try {
            const { awardCompletionPoints } = require('./couponSettings')
            await awardCompletionPoints(pg, hotelId, updated.rows[0].user_id, row.id)
          } catch (err) {
            console.error('awardCompletionPoints:', err.message)
          }
        }
      }
      continue
    }

    if (pms.ci && !alreadyTerminal.has(row.status)) {
      const updated = await pg.query(
        `UPDATE bookings
         SET status = 'checked_in', updated_at = NOW()
         WHERE id = $1 AND hotel_id = $2
           AND status NOT IN ('cancelled', 'checked_in', 'checked_out')
         RETURNING id`,
        [row.id, hotelId]
      )
      if (updated.rows[0]) checkedInIds.push(row.id)
    }
  }

  if (cancelledIds.length || checkedInIds.length || checkedOutIds.length) {
    const { emitBookingChanged } = require('./bookingEvents')
    const { notifyBookingCancelledChat } = require('./bookingChatNotify')
    for (const bookingId of cancelledIds) {
      emitBookingChanged(hotelId, { type: 'cancelled', booking_id: bookingId })
      notifyBookingCancelledChat(pg, hotelId, bookingId).catch(() => null)
    }
    for (const bookingId of checkedInIds) {
      emitBookingChanged(hotelId, { type: 'checked_in', booking_id: bookingId })
    }
    for (const bookingId of checkedOutIds) {
      emitBookingChanged(hotelId, { type: 'checked_out', booking_id: bookingId })
    }
  }

  return { cancelledIds, checkedInIds, checkedOutIds }
}

async function maybeSyncPmsStatuses(pg, hotelId) {
  try {
    return await syncPmsStatuses(pg, hotelId)
  } catch (err) {
    console.warn('[pms] status sync failed:', err.message)
    return emptyPmsSyncResult()
  }
}

/** alias — ซิงก์ CXL + CI + CO แล้วคืนเฉพาะ id ที่ยกเลิก (เส้นเก่าไม่พัง) */
async function maybeSyncPmsCancellations(pg, hotelId) {
  const { cancelledIds } = await maybeSyncPmsStatuses(pg, hotelId)
  return cancelledIds
}

async function syncPmsCancellations(pg, hotelId) {
  const { cancelledIds } = await syncPmsStatuses(pg, hotelId)
  return cancelledIds
}

async function syncAllPmsStatuses(pg) {
  const hotels = await pg.query(
    `SELECT hotel_id FROM hotel_settings
     WHERE setting_key = 'kiosk_enabled' AND setting_value = 'true'`
  )
  let cancelled = 0
  let checkedIn = 0
  let checkedOut = 0
  for (const row of hotels.rows) {
    const result = await maybeSyncPmsStatuses(pg, row.hotel_id)
    cancelled += result.cancelledIds.length
    checkedIn += result.checkedInIds.length
    checkedOut += result.checkedOutIds.length
  }
  return { cancelled, checkedIn, checkedOut }
}

async function syncAllPmsCancellations(pg) {
  const { cancelled, checkedIn, checkedOut } = await syncAllPmsStatuses(pg)
  return cancelled + checkedIn + checkedOut
}

async function maybePushBookingToPms(pg, hotelId, bookingId) {
  try {
    const result = await pushBookingToPms(pg, hotelId, bookingId)
    return {
      skipped: Boolean(result.skipped),
      sent: Boolean(result.newResvNo) && !result.skipped,
      newResvNo: result.newResvNo || null,
      roomNo: result.roomNo || null,
      otaBookingNo: result.otaBookingNo || null,
    }
  } catch (err) {
    console.error('[pms] push failed:', err.message)
    return { skipped: false, sent: false, error: err.message }
  }
}

/** ตั้ง ResvStatus = CXL ใน PMS ตาม ResvNo */
async function cancelReservationInPms({ dbName, resvNo, loginId }) {
  const resvNoInt = parseInt(resvNo, 10)
  if (!dbName || !Number.isInteger(resvNoInt) || resvNoInt <= 0) {
    throw new Error('ข้อมูลยกเลิก PMS ไม่ครบ')
  }

  // วันปฏิทิน Bangkok ที่ 00:00:00.000 (เช่น 2026-09-03 00:00:00.000) — ไม่ใช้ GETDATE() ที่มีเวลา
  const visaBgDate = asDate(new Date())

  const pool = await connectDynamicDB(dbName)
  try {
    void loginId
    const result = await pool.request()
      .input('ResvNo', sql.Int, resvNoInt)
      .input('VisaBgDate', sql.DateTime, visaBgDate)
      .query(`
      UPDATE Reservation
      SET ResvStatus = 'CXL',
          VisaBgDate = @VisaBgDate
      WHERE ResvNo = @ResvNo
        AND LTRIM(RTRIM(ISNULL(ResvStatus, ''))) <> 'CXL'
        AND LTRIM(RTRIM(ISNULL(Status, ''))) NOT IN ('CI', 'CO')
    `)
    const affected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((sum, n) => sum + (Number(n) || 0), 0)
      : Number(result.rowsAffected) || 0

    const check = await pool.request()
      .input('ResvNo', sql.Int, resvNoInt)
      .query(`
        SELECT TOP 1
               LTRIM(RTRIM(ResvStatus)) AS ResvStatus,
               LTRIM(RTRIM(Status)) AS Status
        FROM Reservation
        WHERE ResvNo = @ResvNo
        ORDER BY CASE WHEN RoomCount = 1 THEN 0 ELSE 1 END, GstNo
      `)
    const row = check.recordset?.[0]
    if (!row) throw new Error('ไม่พบการจองใน PMS')
    if (trimPmsCode(row.Status) === 'CI' || trimPmsCode(row.Status) === 'CO') {
      throw new Error('จองนี้เช็คอิน/เช็คเอาต์ใน PMS แล้ว ยกเลิกไม่ได้')
    }
    if (trimPmsCode(row.ResvStatus) !== 'CXL' && affected <= 0) {
      throw new Error('ยกเลิกใน PMS ไม่สำเร็จ')
    }
    return { resvNo: resvNoInt, affected }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function cancelBookingInPms(pg, hotelId, bookingId) {
  const settings = await getHotelSettings(pg, hotelId, [
    'kiosk_enabled', 'kiosk_db_name', 'kiosk_login_id',
  ])
  if (settings.kiosk_enabled !== 'true') return { skipped: true }

  const bookingResult = await pg.query(
    `SELECT id, status, pms_resv_no FROM bookings WHERE id = $1 AND hotel_id = $2 LIMIT 1`,
    [bookingId, hotelId]
  )
  const row = bookingResult.rows[0]
  if (!row) throw new Error('ไม่พบการจอง')
  if (!row.pms_resv_no) return { skipped: true, reason: 'no_pms_resv' }

  try {
    const result = await cancelReservationInPms({
      dbName: settings.kiosk_db_name,
      resvNo: row.pms_resv_no,
      loginId: settings.kiosk_login_id,
    })
    await pg.query(
      `UPDATE bookings SET pms_last_error = NULL, updated_at = NOW() WHERE id = $1 AND hotel_id = $2`,
      [bookingId, hotelId]
    )
    return { skipped: false, sent: true, ...result }
  } catch (err) {
    await pg.query(
      `UPDATE bookings SET pms_last_error = $3, updated_at = NOW() WHERE id = $1 AND hotel_id = $2`,
      [bookingId, hotelId, String(err.message || 'ยกเลิก PMS ไม่สำเร็จ').slice(0, 500)]
    )
    throw err
  }
}

async function maybeCancelBookingInPms(pg, hotelId, bookingId) {
  try {
    const result = await cancelBookingInPms(pg, hotelId, bookingId)
    return {
      skipped: Boolean(result.skipped),
      sent: Boolean(result.sent),
      resvNo: result.resvNo || null,
      error: null,
    }
  } catch (err) {
    console.error('[pms] cancel failed:', err.message)
    return { skipped: false, sent: false, error: err.message }
  }
}

module.exports = {
  pushBookingToPms,
  maybePushBookingToPms,
  cancelBookingInPms,
  maybeCancelBookingInPms,
  cancelReservationInPms,
  saveKioskBookingToPms,
  syncPmsStatuses,
  maybeSyncPmsStatuses,
  syncAllPmsStatuses,
  syncPmsCancellations,
  maybeSyncPmsCancellations,
  syncAllPmsCancellations,
}
