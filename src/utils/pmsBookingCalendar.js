/**
 * ปฏิทินจองจาก PMS
 * ตั้งแต่วันนี้ไปข้างหน้าใช้ Sp_Forecast_RoomNo แบบ Booking Calendar
 * ก่อนวันนี้สร้างจาก Front_Journal_CheckOut (folio history)
 */

const { sql, connectDynamicDB } = require('../db/mssql')
const { getKioskSysDate } = require('./kioskVacantRooms')

// เท่ากับช่วงยาวสุดที่ Booking Calendar ของ PMS ให้เลือก
const MAX_DAYS = 90

function trim(value) {
  return String(value ?? '').trim()
}

function roomKey(value) {
  return trim(value).toUpperCase()
}

function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
}

function addDays(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + days))
  return dt.toISOString().slice(0, 10)
}

function eachDate(from, to) {
  const out = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return out
  let cursor = from
  while (cursor <= to) {
    out.push(cursor)
    if (out.length > MAX_DAYS) break
    cursor = addDays(cursor, 1)
  }
  return out
}

function parseForecastCell(value) {
  if (value == null) return null
  const raw = String(value)
  if (!trim(raw)) return null
  const spaces = (raw.match(/^ */) || [''])[0].length
  let kind = 'booked'
  if (spaces === 3) kind = 'unconfirmed'
  else if (spaces === 2) kind = 'ooo'
  else if (spaces === 1) kind = 'inhouse'
  const body = raw.trim()
  const agentAt = body.lastIndexOf('$$')
  const core = agentAt === -1 ? body : body.slice(0, agentAt)
  const dash = core.indexOf('--')
  const guest = dash === -1 ? core.trim() : core.slice(0, dash).trim()
  const resvMatch = dash === -1 ? null : core.slice(dash + 2).match(/^(\d+)/)
  return {
    guest: guest || (kind === 'ooo' ? 'ปิดใช้งาน' : ''),
    resvNo: resvMatch ? resvMatch[1] : '',
    kind,
    source: 'forecast',
  }
}

function ensureRoom(map, roomNo, extra = {}) {
  const key = roomKey(roomNo)
  if (!key) return null
  if (!map.has(key)) {
    map.set(key, {
      roomNo: trim(roomNo),
      roomType: trim(extra.roomType),
      typeName: trim(extra.typeName) || trim(extra.roomType) || 'ไม่ระบุประเภท',
      floor: extra.floor != null ? Number(extra.floor) : null,
      cells: {},
    })
  } else if (extra.typeName && map.get(key).typeName === 'ไม่ระบุประเภท') {
    map.get(key).typeName = trim(extra.typeName)
    if (extra.roomType) map.get(key).roomType = trim(extra.roomType)
  }
  return map.get(key)
}

async function listRooms(pool, hotelID) {
  const result = await pool.request()
    .input('HotelId', sql.Int, Number(hotelID))
    .query(`
      SELECT
        LTRIM(RTRIM(RmNum)) AS RoomNo,
        LTRIM(RTRIM(RmType)) AS RoomType,
        RmFloor AS Floor
      FROM RmSetupNum
      WHERE HotelID = @HotelId
        AND ISNULL(RmFloor, 0) > 0
      ORDER BY RmFloor, RmNum
    `)
  return result.recordset || []
}

async function loadForecast(pool, { hotelID, comNo, bgn, end }) {
  await pool.request()
    .input('Bgn_Date', sql.DateTime, new Date(`${bgn}T00:00:00Z`))
    .input('End_Date', sql.DateTime, new Date(`${end}T00:00:00Z`))
    .input('ComNo', sql.SmallInt, Number(comNo))
    .input('HotelID', sql.SmallInt, Number(hotelID))
    .execute('dbo.Sp_Forecast_RoomNo')

  const totalDays = Math.min(
    MAX_DAYS,
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${bgn}T00:00:00Z`)) / 86400000) + 1,
  )
  const columns = ['fr.RoomNo', 'fr.RoomType', 'rt.RmTpName']
  for (let i = 1; i <= totalDays; i += 1) columns.push(`fr.D${i}`)
  const result = await pool.request()
    .input('ComNo', sql.SmallInt, Number(comNo))
    .input('HotelID', sql.SmallInt, Number(hotelID))
    .query(`
      SELECT ${columns.join(', ')}
      FROM dbo.Forecast_RoomNo AS fr
      LEFT JOIN dbo.RmType AS rt ON fr.RmTypeNo = rt.RmTypeNo
      WHERE fr.ComNo = @ComNo AND fr.HotelID = @HotelID
      ORDER BY fr.RmFloor, fr.RoomNo
    `)
  return { rows: result.recordset || [], totalDays }
}

async function loadFolioStays(pool, hotelID, from, to) {
  const result = await pool.request()
    .input('HotelId', sql.Int, Number(hotelID))
    .input('FromDate', sql.Date, new Date(`${from}T00:00:00Z`))
    .input('ToDate', sql.Date, new Date(`${to}T00:00:00Z`))
    .query(`
      SELECT
        LTRIM(RTRIM(RoomNo)) AS RoomNo,
        FolioNo,
        MAX(ResvNo) AS ResvNo,
        MAX(LTRIM(RTRIM(ISNULL(GstName, '')))) AS GstName,
        CONVERT(varchar(10), MIN(Buss_Date), 23) AS FirstNight,
        CONVERT(varchar(10), MAX(CheckOut_Date), 23) AS CheckOutDate
      FROM Front_Journal_CheckOut
      WHERE HotelId = @HotelId
        AND RoomNo IS NOT NULL
        AND LTRIM(RTRIM(RoomNo)) <> ''
        AND CAST(CheckOut_Date AS date) > @FromDate
        AND CAST(ISNULL(Buss_Date, CheckOut_Date) AS date) <= @ToDate
      GROUP BY LTRIM(RTRIM(RoomNo)), FolioNo
    `)
  return result.recordset || []
}

async function loadCheckedInStays(pool, hotelID) {
  const full = `
    SELECT
      LTRIM(RTRIM(RM.RmNum)) AS RoomNo,
      LTRIM(RTRIM(ISNULL(RM.RmGstName1, ''))) AS GstName,
      RM.ResvNo,
      CONVERT(varchar(10),
        CASE
          WHEN A.ArrivalDate IS NULL THEN COALESCE(N.FirstNight, RM.RmStatusStrDate)
          WHEN N.FirstNight IS NULL THEN A.ArrivalDate
          WHEN N.FirstNight < A.ArrivalDate THEN N.FirstNight
          ELSE A.ArrivalDate
        END, 23) AS ArrivalDate
    FROM dbo.RmSetupNum RM
    OUTER APPLY (
      SELECT MIN(R.ArrivalDate) AS ArrivalDate
      FROM dbo.Reservation R
      WHERE R.Status = 'CI'
        AND LTRIM(RTRIM(R.RoomNo)) = LTRIM(RTRIM(RM.RmNum))
    ) A
    OUTER APPLY (
      SELECT MIN(J.Buss_Date) AS FirstNight
      FROM dbo.Front_Journal J
      WHERE LTRIM(RTRIM(J.ChargeRoomNo)) = LTRIM(RTRIM(RM.RmNum))
        AND ISNULL(J.VOID, 0) = 0
        AND J.FolioNo = (
          SELECT MAX(F.foliono)
          FROM dbo.folioname F
          WHERE LTRIM(RTRIM(F.chargeroomno)) = LTRIM(RTRIM(RM.RmNum))
        )
    ) N
    WHERE RM.HotelID = @HotelId
      AND LTRIM(RTRIM(RM.RmStatus)) = 'CI'
      AND ISNULL(RM.RmFloor, 0) > 0
  `
  try {
    const result = await pool.request().input('HotelId', sql.Int, Number(hotelID)).query(full)
    return result.recordset || []
  } catch {
    const result = await pool.request()
      .input('HotelId', sql.Int, Number(hotelID))
      .query(`
        SELECT
          LTRIM(RTRIM(RmNum)) AS RoomNo,
          LTRIM(RTRIM(ISNULL(RmGstName1, ''))) AS GstName,
          ResvNo,
          CONVERT(varchar(10), RmStatusStrDate, 23) AS ArrivalDate
        FROM dbo.RmSetupNum
        WHERE HotelID = @HotelId
          AND LTRIM(RTRIM(RmStatus)) = 'CI'
          AND ISNULL(RmFloor, 0) > 0
      `)
    return result.recordset || []
  }
}

function paintOpenStay(room, arrival, guest, resvNo, dates, today) {
  let night = String(arrival || '').slice(0, 10)
  if (!night || night >= today) return
  const start = dates[0]
  const yesterday = addDays(today, -1)
  if (night < start) night = start
  while (night && night <= yesterday) {
    if (!room.cells[night]) {
      room.cells[night] = {
        guest: guest || 'แขก',
        resvNo,
        kind: 'inhouse',
        source: 'forecast',
      }
    }
    night = addDays(night, 1)
  }
}

function paintStay(room, stay, dates, today) {
  const guest = trim(stay.GstName) || 'แขก'
  const resvNo = stay.ResvNo != null ? String(stay.ResvNo) : ''
  let night = String(stay.FirstNight || '').slice(0, 10)
  const depart = String(stay.CheckOutDate || '').slice(0, 10)
  if (!night || !depart) return
  if (depart <= night) night = addDays(depart, -1)
  const limit = dates[dates.length - 1]
  const start = dates[0]
  while (night && night < depart && night <= limit) {
    if (night >= start && night < today && !room.cells[night]) {
      room.cells[night] = {
        guest,
        resvNo,
        folioNo: stay.FolioNo != null ? String(stay.FolioNo) : '',
        arrival: String(stay.FirstNight || '').slice(0, 10),
        departure: depart,
        kind: 'history',
        source: 'folio',
      }
    }
    night = addDays(night, 1)
  }
}

async function loadPmsBookingCalendar({ dbName, hotelID, comNo, bgnDate, endDate }) {
  const today = todayBangkok()
  const sysDate = await getKioskSysDate({ dbName, hotelID })
  let bgn = /^\d{4}-\d{2}-\d{2}$/.test(bgnDate) ? bgnDate : today
  let end = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : addDays(bgn, 9)
  if (end < bgn) end = bgn
  const dates = eachDate(bgn, end)
  if (!dates.length) {
    const error = new Error('ช่วงวันที่ไม่ถูกต้อง')
    error.status = 400
    throw error
  }
  if (dates.length > MAX_DAYS || addDays(bgn, MAX_DAYS - 1) < end) {
    const error = new Error(`ดูได้ไม่เกิน ${MAX_DAYS} วันต่อครั้ง`)
    error.status = 400
    throw error
  }

  const pool = await connectDynamicDB(dbName)
  const rooms = new Map()
  let forecastError = ''
  let historyError = ''
  try {
    for (const row of await listRooms(pool, hotelID)) {
      ensureRoom(rooms, row.RoomNo, { roomType: row.RoomType, floor: row.Floor })
    }

    const past = dates.filter((day) => day < today)
    if (past.length) {
      try {
        const stays = await loadFolioStays(pool, hotelID, past[0], past[past.length - 1])
        for (const stay of stays) {
          const room = ensureRoom(rooms, stay.RoomNo)
          if (room) paintStay(room, stay, dates, today)
        }
      } catch (err) {
        historyError = err.message || 'โหลดประวัติ folio ไม่สำเร็จ'
      }
    }

    const future = dates.filter((day) => day >= today)
    if (future.length) {
      if (!comNo) {
        forecastError = 'ยังไม่ได้ตั้งค่า ComNo ของ PMS'
      } else {
        try {
          const { rows, totalDays } = await loadForecast(pool, {
            hotelID,
            comNo,
            bgn: future[0],
            end: future[future.length - 1],
          })
          rows.forEach((row) => {
            const room = ensureRoom(rooms, row.RoomNo, {
              roomType: row.RoomType,
              typeName: row.RmTpName,
            })
            if (!room) return
            for (let i = 0; i < totalDays && i < future.length; i += 1) {
              const parsed = parseForecastCell(row[`D${i + 1}`])
              if (parsed) room.cells[future[i]] = parsed
            }
          })
        } catch (err) {
          forecastError = err.message || 'โหลดตารางจองไม่สำเร็จ'
        }
      }
    }

    const pastOpen = dates.some((day) => day < today)
    if (pastOpen) {
      try {
        const openStays = await loadCheckedInStays(pool, hotelID)
        for (const stay of openStays) {
          const room = rooms.get(roomKey(stay.RoomNo))
          if (!room) continue
          const current = room.cells[today]
          const linked = current && current.kind === 'inhouse'
          paintOpenStay(
            room,
            stay.ArrivalDate,
            linked && current.guest ? current.guest : trim(stay.GstName),
            linked && current.resvNo ? current.resvNo : (stay.ResvNo != null ? String(stay.ResvNo) : ''),
            dates,
            today,
          )
        }
      } catch (err) {
        if (!historyError) historyError = err.message || 'ต่อคืนก่อนวันนี้ของห้องที่เช็คอินไม่สำเร็จ'
      }
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }

  const list = [...rooms.values()].sort((a, b) => {
    const floor = (a.floor || 0) - (b.floor || 0)
    if (floor) return floor
    return a.roomNo.localeCompare(b.roomNo, undefined, { numeric: true })
  })

  return {
    today,
    sysDate: sysDate || null,
    bgnDate: dates[0],
    endDate: dates[dates.length - 1],
    dates,
    rooms: list,
    forecastError,
    historyError,
  }
}

function thaiDateTime(year, month, day, hours = 0, minutes = 0, seconds = 0) {
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds))
}

function parseThaiDate(value, hours = 0) {
  const match = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return thaiDateTime(Number(match[1]), Number(match[2]), Number(match[3]), hours)
}

function thaiNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const part = (type) => Number(parts.find((item) => item.type === type).value)
  return thaiDateTime(part('year'), part('month'), part('day'), part('hour'), part('minute'), part('second'))
}

async function stopSaleRoom({ dbName, roomNo, dateBegin, dateEnd, remark, userId }) {
  const room = trim(roomNo)
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const note = trim(remark).slice(0, 30) || 'StopSale'
  const begin = parseThaiDate(dateBegin, 0)
  const end = parseThaiDate(dateEnd, 0)
  const endTime = parseThaiDate(dateEnd, 12)
  if (!room || room.length > 7 || !begin || !end || end < begin) {
    const error = new Error('ข้อมูลปิดการขายไม่ครบ')
    error.status = 400
    throw error
  }
  if (String(dateBegin).slice(0, 10) < todayBangkok()) {
    const error = new Error('ปิดการขายย้อนหลังไม่ได้')
    error.status = 400
    throw error
  }
  const pool = await connectDynamicDB(dbName)
  try {
    await pool.request()
      .input('RoomNo', sql.VarChar(7), room)
      .input('Status', sql.VarChar(3), 'OOO')
      .input('DateTime', sql.DateTime, thaiNow())
      .input('DateBegin', sql.DateTime, begin)
      .input('DateEnd', sql.DateTime, end)
      .input('BgnTime', sql.DateTime, thaiNow())
      .input('EndTime', sql.DateTime, endTime)
      .input('remark', sql.VarChar(30), note)
      .input('UserId', sql.VarChar(20), user)
      .execute('dbo.sp_updateroomstatus')
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
  return { roomNo: room, remark: note }
}

async function releaseSaleRoom({ dbName, roomNo, resvNo, ref, bussDate, userId }) {
  const room = trim(roomNo)
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const note = trim(ref).slice(0, 30) || 'OpenSale'
  const reservationNo = Number(resvNo)
  const businessDate = parseThaiDate(bussDate, 0)
  if (!room || room.length > 7 || !Number.isInteger(reservationNo) || !businessDate) {
    const error = new Error('ข้อมูลปลดห้องไม่ครบ')
    error.status = 400
    throw error
  }
  const pool = await connectDynamicDB(dbName)
  try {
    await pool.request()
      .input('BussDate', sql.DateTime, businessDate)
      .input('RoomNo', sql.VarChar(7), room)
      .input('NewStatus', sql.VarChar(3), 'VD')
      .input('UserId', sql.VarChar(20), user)
      .input('Ref', sql.VarChar(30), note)
      .input('ResvNo', sql.Int, reservationNo)
      .execute('dbo.Sp_Release_RoomStatus')
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
  return { roomNo: room, resvNo: reservationNo }
}

function fail(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function money(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

async function folioNoOf(pool, roomNo) {
  const result = await pool.request()
    .input('roomno', sql.VarChar(7), roomNo)
    .query(`SELECT MAX(foliono) AS FoNo FROM dbo.folioname WHERE LTRIM(RTRIM(chargeroomno)) = @roomno`)
  const folioNo = Number(result.recordset?.[0]?.FoNo)
  return Number.isInteger(folioNo) && folioNo > 0 ? folioNo : null
}

async function folioBalance(pool, roomNo, folioNo) {
  const result = await pool.request()
    .input('roomno', sql.VarChar(7), roomNo)
    .input('foliono', sql.Int, folioNo)
    .input('adjust', sql.Int, 0)
    .output('service', sql.Float, 0)
    .output('tax', sql.Float, 0)
    .output('amount', sql.Float, 0)
    .execute('dbo.sp_get_subtotal')
  return {
    service: money(result.output.service),
    tax: money(result.output.tax),
    amount: money(result.output.amount),
  }
}

async function folioLines(pool, roomNo, folioNo, sysDate) {
  try {
    const result = await pool.request()
      .input('roomno', sql.VarChar(7), roomNo)
      .input('foliono', sql.Int, folioNo)
      .query(`
        SELECT TOP 100
          F.RecID AS recId,
          CONVERT(varchar(16), F.DateTime, 120) AS postedAt,
          CONVERT(varchar(10), ISNULL(F.Buss_Date, F.DateTime), 23) AS businessDate,
          LTRIM(RTRIM(F.Trans_Code)) AS code,
          LTRIM(RTRIM(ISNULL(T.TrnName, F.Trans_Code))) AS name,
          F.Qty AS qty,
          F.Amount AS amount,
          F.Charge_Type AS chargeType,
          ISNULL(F.Shift_No, 1) AS shiftNo,
          LTRIM(RTRIM(ISNULL(F.Remark, ''))) AS remark,
          LTRIM(RTRIM(ISNULL(F.Ref_No, ''))) AS refNo
        FROM dbo.Front_Journal F
        LEFT JOIN dbo.TrnCode T ON LTRIM(RTRIM(F.Trans_Code)) = LTRIM(RTRIM(T.TrnCode))
        WHERE LTRIM(RTRIM(F.ChargeRoomNo)) = @roomno
          AND F.FolioNo = @foliono
          AND ISNULL(F.Adjust, 0) = 0
          AND ISNULL(F.VOID, 0) = 0
        ORDER BY F.DateTime DESC, F.RecID DESC
      `)
    return (result.recordset || []).map((row) => {
      const businessDate = String(row.businessDate || '').slice(0, 10)
      return {
        recId: Number(row.recId) || 0,
        postedAt: row.postedAt,
        businessDate,
        code: trim(row.code),
        name: trim(row.name),
        qty: Number(row.qty) || 0,
        amount: money(row.chargeType === -1 ? -Math.abs(row.amount) : row.amount),
        isPayment: Number(row.chargeType) === -1,
        shiftNo: Number(row.shiftNo) || 1,
        remark: trim(row.remark),
        refNo: trim(row.refNo),
        // แคชเชียร์ PMS ยกเลิกได้เฉพาะรายการวันทำการปัจจุบัน
        canVoid: Boolean(sysDate) && businessDate === sysDate && Number(row.recId) > 0,
      }
    })
  } catch {
    return []
  }
}

async function folioCatalog(pool) {
  // ตรงกับแคชเชียร์ PMS:
  // - getitempage: TrnGroupCode='1' แล้วแยก Posting (TrnCredit=0) / Rebate (TrnCredit=1)
  // - getPayment: TrnGrp=9 เท่านั้น (ไม่รวมรีเบท)
  const [items, payments, companies] = await Promise.all([
    pool.request().query(`
      SELECT
        LTRIM(RTRIM(TrnCode)) AS code,
        LTRIM(RTRIM(TrnName)) AS name,
        TrnPrice1 AS price,
        ISNULL(TrnCredit, 0) AS credit
      FROM dbo.TrnCode
      WHERE TrnGroupCode = '1' AND TrnCodeRecordStatus = 'Y'
      ORDER BY TrnCode
    `),
    pool.request().query(`
      SELECT LTRIM(RTRIM(TrnCode)) AS code, LTRIM(RTRIM(TrnName)) AS name
      FROM dbo.TrnCode
      WHERE TrnGrp = 9 AND TrnCodeRecordStatus = 'Y'
      ORDER BY TrnCode
    `),
    pool.request().query(`
      SELECT LTRIM(RTRIM(AgNum)) AS code, LTRIM(RTRIM(AgName)) AS name
      FROM dbo.Agent
      WHERE Status = 'A' AND Contact = 'Y'
      ORDER BY AgName
    `).catch(() => ({ recordset: [] })),
  ])
  const mapCode = (row) => ({
    code: trim(row.code),
    name: trim(row.name),
    price: money(row.price),
    credit: Number(row.credit) === 1 ? 1 : 0,
  })
  const allItems = (items.recordset || []).map(mapCode).filter((row) => row.code)
  return {
    charges: allItems.filter((row) => row.credit === 0),
    rebates: allItems.filter((row) => row.credit === 1),
    payments: (payments.recordset || []).map(mapCode).filter((row) => row.code),
    companies: (companies.recordset || []).map(mapCode).filter((row) => row.code),
  }
}

async function businessDateOf(pool, hotelID) {
  try {
    const result = await pool.request()
      .input('hotelID', sql.Int, Number(hotelID) || 0)
      .query(`
        SELECT TOP 1 CONVERT(varchar(10), ci.SysDate, 23) AS sys_date
        FROM FRONT_OPTION fo
        LEFT JOIN CustInfo ci ON ci.HotelID = fo.HotelID
        WHERE (@hotelID = 0 OR fo.HotelID = @hotelID)
      `)
    const raw = result.recordset?.[0]?.sys_date
    return raw ? String(raw).slice(0, 10) : todayBangkok()
  } catch {
    return todayBangkok()
  }
}

async function getRoomFolio({ dbName, hotelID, roomNo }) {
  const room = trim(roomNo)
  if (!room) throw fail('ไม่ได้ระบุห้อง')
  const pool = await connectDynamicDB(dbName)
  try {
    const status = await pool.request()
      .input('RmNum', sql.VarChar(7), room)
      .query(`
        SELECT
          LTRIM(RTRIM(RmStatus)) AS RmStatus,
          ResvNo,
          LTRIM(RTRIM(ISNULL(RmGstName1, ''))) AS GuestName,
          ISNULL(RmRateAmt, 0) AS RoomRate,
          CONVERT(varchar(10), RmStatusStrDate, 23) AS ArrivalYmd,
          CONVERT(varchar(10), RmStatusEndDate, 23) AS DeptYmd,
          LTRIM(RTRIM(ISNULL(RmType, ''))) AS RoomType
        FROM dbo.RmSetupNum
        WHERE LTRIM(RTRIM(RmNum)) = @RmNum
      `)
    const row = status.recordset?.[0]
    if (!row) throw fail('ไม่พบห้องใน PMS', 404)
    const inHouse = String(row.RmStatus || '').toUpperCase() === 'CI'
    if (!inHouse) throw fail('ห้องนี้ไม่ได้เช็คอิน จึงเช็คเอาต์หรือลงรายการไม่ได้')
    const folioNo = await folioNoOf(pool, room)
    if (!folioNo) throw fail('ไม่พบโฟลิโอของห้องนี้')
    const sysDate = await businessDateOf(pool, hotelID)
    const [balance, lines, catalog] = await Promise.all([
      folioBalance(pool, room, folioNo),
      folioLines(pool, room, folioNo, sysDate),
      folioCatalog(pool),
    ])
    const amount = money(balance.amount)
    return {
      roomNo: room,
      status: row.RmStatus,
      resvNo: row.ResvNo != null ? String(row.ResvNo) : '',
      folioNo,
      guestName: trim(row.GuestName),
      roomType: trim(row.RoomType),
      rate: money(row.RoomRate),
      arrival: String(row.ArrivalYmd || '').slice(0, 10),
      departure: String(row.DeptYmd || '').slice(0, 10),
      sysDate,
      balance: { ...balance, amount },
      lines,
      ...catalog,
      canCheckout: Math.abs(amount) < 0.01,
      overpaid: amount < -0.01,
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function postFolioEntry({ dbName, hotelID, roomNo, userId, kind, trnCode, quantity, amount, remark, company }) {
  const room = trim(roomNo)
  const code = trim(trnCode)
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const qty = Math.max(1, Number(quantity) || 1)
  const amt = money(amount)
  if (!room || !code) throw fail('เลือกห้องและรายการก่อน')
  if (amt < 0) throw fail('จำนวนเงินต้องไม่ติดลบ')
  const pool = await connectDynamicDB(dbName)
  try {
    const status = await pool.request()
      .input('RmNum', sql.VarChar(7), room)
      .query(`SELECT LTRIM(RTRIM(RmStatus)) AS RmStatus FROM dbo.RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RmNum`)
    const rmStatus = String(status.recordset?.[0]?.RmStatus || '').toUpperCase()
    if (rmStatus !== 'CI') throw fail('ห้องนี้ไม่ได้เช็คอิน')
    const folioNo = await folioNoOf(pool, room)
    if (!folioNo) throw fail('ไม่พบโฟลิโอของห้องนี้')
    await pool.request()
      .input('id', sql.Int, 0)
      .input('roomno', sql.VarChar(7), room)
      .input('foliono', sql.Int, folioNo)
      .input('transcode', sql.VarChar(10), code)
      .input('quantity', sql.Int, kind === 'payment' ? 1 : qty)
      .input('ChgAmt', sql.Float, amt)
      .input('userid', sql.VarChar(20), user)
      .input('refno', sql.VarChar(30), '')
      .input('remark', sql.VarChar(50), trim(remark).slice(0, 50) || ' ')
      .input('ShiftNo', sql.Int, 1)
      .input('AuditPost', sql.Int, 0)
      .input('Reason', sql.VarChar(20), '')
      .input('folioadjust', sql.Int, 0)
      .input('vDeptPost', sql.Int, 4)
      .input('CommAmt', sql.Float, kind === 'payment' ? amt : 0)
      .input('CurrencyCode', sql.VarChar(5), '')
      .input('CurrencyRate', sql.Float, 0)
      .input('CurrencyAmount', sql.Float, kind === 'payment' ? amt : 0)
      .input('VoucherNo', sql.VarChar(20), '')
      .input('AgentCode', sql.VarChar(10), kind === 'payment' ? trim(company).slice(0, 10) : '')
      .input('HotelId', sql.Int, Number(hotelID))
      .execute('dbo.sp_save_journal')
    return getRoomFolio({ dbName, hotelID, roomNo: room })
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

/** ยกเลิกรายการโฟลิโอแบบแคชเชียร์ PMS (sp_void_journal)
 * ยกเลิกได้เฉพาะรายการวันทำการปัจจุบันที่ยังไม่ void
 */
async function voidFolioLine({ dbName, hotelID, roomNo, userId, recId, reason }) {
  const room = trim(roomNo)
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const id = Number(recId)
  const why = trim(reason).slice(0, 50) || 'ยกเลิกจากปฏิทิน'
  if (!room || !Number.isInteger(id) || id <= 0) throw fail('เลือกรายการที่จะยกเลิกก่อน')
  const pool = await connectDynamicDB(dbName)
  try {
    const status = await pool.request()
      .input('RmNum', sql.VarChar(7), room)
      .query(`SELECT LTRIM(RTRIM(RmStatus)) AS RmStatus FROM dbo.RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RmNum`)
    if (String(status.recordset?.[0]?.RmStatus || '').toUpperCase() !== 'CI') {
      throw fail('ห้องนี้ไม่ได้เช็คอิน')
    }
    const folioNo = await folioNoOf(pool, room)
    if (!folioNo) throw fail('ไม่พบโฟลิโอของห้องนี้')
    const sysDate = await businessDateOf(pool, hotelID)
    const line = await pool.request()
      .input('RecID', sql.Int, id)
      .input('RoomNo', sql.VarChar(7), room)
      .input('FolioNo', sql.Int, folioNo)
      .query(`
        SELECT TOP 1
          F.RecID AS recId,
          CONVERT(varchar(10), ISNULL(F.Buss_Date, F.DateTime), 23) AS businessDate,
          ISNULL(F.VOID, 0) AS voided,
          ISNULL(F.Shift_No, 1) AS shiftNo
        FROM dbo.Front_Journal F
        WHERE F.RecID = @RecID
          AND LTRIM(RTRIM(F.ChargeRoomNo)) = @RoomNo
          AND F.FolioNo = @FolioNo
      `)
    const row = line.recordset?.[0]
    if (!row) throw fail('ไม่พบรายการในโฟลิโอนี้', 404)
    if (Number(row.voided)) throw fail('รายการนี้ถูกยกเลิกไปแล้ว')
    if (String(row.businessDate || '').slice(0, 10) !== sysDate) {
      throw fail('ยกเลิกได้เฉพาะรายการของวันทำการปัจจุบัน เหมือนแคชเชียร์ PMS')
    }
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('UserEdit', sql.VarChar(20), user)
      .input('Reason', sql.VarChar(50), why)
      .input('ShiftNo', sql.Int, Number(row.shiftNo) || 1)
      .execute('sp_void_journal')
    if (!(result.rowsAffected?.[0] > 0)) throw fail('ยกเลิกรายการไม่สำเร็จ')
    return getRoomFolio({ dbName, hotelID, roomNo: room })
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function checkoutRoomFolio({ dbName, roomNo, userId }) {
  const room = trim(roomNo)
  const user = trim(userId).slice(0, 20) || 'webadmin'
  if (!room) throw fail('ไม่ได้ระบุห้อง')
  const pool = await connectDynamicDB(dbName)
  try {
    const status = await pool.request()
      .input('RmNum', sql.VarChar(7), room)
      .query(`SELECT LTRIM(RTRIM(RmStatus)) AS RmStatus FROM dbo.RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RmNum`)
    if (String(status.recordset?.[0]?.RmStatus || '').toUpperCase() !== 'CI') {
      throw fail('ห้องนี้ไม่ได้เช็คอิน จึงเช็คเอาต์ไม่ได้')
    }
    const folioNo = await folioNoOf(pool, room)
    if (!folioNo) throw fail('ไม่พบโฟลิโอของห้องนี้')
    const balance = await folioBalance(pool, room, folioNo)
    if (balance.amount > 0.009) {
      throw fail(`ยังมียอดค้าง ฿${balance.amount.toLocaleString()} ลงรายการชำระให้ครบก่อนเช็คเอาต์`)
    }
    if (balance.amount < -0.009) {
      throw fail(`มียอดเกินชำระ ฿${Math.abs(balance.amount).toLocaleString()} ยกเลิกรายการชำระส่วนเกินก่อนเช็คเอาต์`)
    }
    await pool.request()
      .input('foliono', sql.Int, folioNo)
      .input('ShiftNo', sql.Int, 1)
      .output('RoomOut', sql.SmallInt)
      .input('UserId', sql.VarChar(20), user)
      .execute('dbo.sp_folio_check_out')
    return { roomNo: room, folioNo, checkedOut: true }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

// ข้อมูลที่ PMS บังคับก่อนบันทึกการจอง/เช็คอิน (IndividualCheckIn saveBooking)
const CHECKIN_FIELDS = [
  { key: 'firstName', column: 'GstFName', label: 'ชื่อผู้เข้าพัก', type: 'text', size: 30 },
  { key: 'nation', column: 'GstNation', label: 'สัญชาติ', type: 'select', size: 3 },
  { key: 'market', column: 'GstMarketCode', label: 'ตลาดลูกค้า', type: 'select', size: 5 },
  { key: 'source', column: 'GstBusSource', label: 'แหล่งที่มา', type: 'select', size: 5 },
  { key: 'guestType', column: 'GstType', label: 'ประเภทลูกค้า', type: 'select', size: 3 },
  { key: 'guestLevel', column: 'GstLevel', label: 'ระดับลูกค้า', type: 'select', size: 3 },
  { key: 'adults', column: 'GstAdult', label: 'จำนวนผู้ใหญ่', type: 'number' },
]

function hmsOf(value) {
  if (value == null) return ''
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(11, 19)
  }
  const match = String(value).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`
}

function timeParam(hms) {
  return hms ? new Date(`1899-12-30T${hms}Z`) : null
}

function dateParam(ymd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? new Date(`${ymd}T00:00:00Z`) : null
}

function isGroupResv(value) {
  return trim(value).toUpperCase() === 'T'
}

async function lookupList(pool, query) {
  try {
    const result = await pool.request().query(query)
    return (result.recordset || [])
      .map((row) => ({ code: trim(row.code), name: trim(row.name) || trim(row.code) }))
      .filter((row) => row.code)
  } catch {
    return []
  }
}

async function checkInLookups(pool) {
  const [nation, market, source, guestType, guestLevel, paidBy, agent, roomType, roomFeature, title, resvStatus] = await Promise.all([
    lookupList(pool, 'SELECT NationalityCode AS code, NationalityName AS name FROM Nationality ORDER BY NationalityName'),
    lookupList(pool, 'SELECT MarketCode AS code, MarketName AS name FROM MarketCode ORDER BY MarketName'),
    lookupList(pool, 'SELECT BusinessCode AS code, BusinessName AS name FROM BusinessSource ORDER BY BusinessName'),
    lookupList(pool, 'SELECT GstType AS code, GstTypeName AS name FROM GstType ORDER BY GstTypeName'),
    lookupList(pool, 'SELECT GstStatusCode AS code, GstStatusName AS name FROM GstLevel ORDER BY GstStatusName'),
    lookupList(pool, `SELECT TrnCode AS code, TrnName AS name FROM TrnCode WHERE TrnDeposit = 'Y' ORDER BY TrnCode`),
    lookupList(pool, 'SELECT AgNum AS code, AgName AS name FROM Agent ORDER BY AgName'),
    lookupList(pool, 'SELECT RmTpCode AS code, RmTpName AS name FROM RmType ORDER BY RmTpName'),
    lookupList(pool, 'SELECT Code AS code, Name AS name FROM RoomFeature ORDER BY Name'),
    lookupList(pool, 'SELECT TitleName AS code, TitleName AS name FROM TitleName ORDER BY TitleName'),
    lookupList(pool, 'SELECT RsStatusCode AS code, RsStatusName AS name FROM RsStatusDetail ORDER BY RsStatusCode'),
  ])
  let defaults = {}
  let times = {}
  let keyCode = ''
  let postRoomOnCheckIn = false
  let roomChargeCode = ''
  try {
    const result = await pool.request().query('SELECT TOP 1 * FROM FRONT_OPTION')
    const row = result.recordset?.[0] || {}
    defaults = {
      nation: trim(row.NationDef),
      market: trim(row.MarketDef),
      source: trim(row.BusSourceDef),
      guestType: trim(row.GstTypeDef),
      guestLevel: trim(row.GstLevelDef),
      agent: trim(row.AgentDef),
    }
    times = { arrival: hmsOf(row.Def_TimeCheckIn), departure: hmsOf(row.Def_TimeCheckOut) }
    postRoomOnCheckIn = trim(row.PostRoomOnCheckIn).toUpperCase() === 'Y'
  } catch { /* ใช้ค่าว่าง */ }
  try {
    const result = await pool.request().query('SELECT TOP 1 * FROM TrnCodeConfig')
    const row = result.recordset?.[0] || {}
    keyCode = trim(row.DepositKey)
    roomChargeCode = trim(row.RoomCharge)
  } catch { /* ไม่มีค่ามัดจำคีย์การ์ด */ }
  return {
    options: {
      nation,
      market,
      source,
      guestType,
      guestLevel,
      paidBy,
      agent,
      roomType,
      roomFeature,
      title,
      resvStatus,
      sex: [
        { code: 'male', name: 'ชาย' },
        { code: 'female', name: 'หญิง' },
      ],
    },
    paidBy,
    defaults,
    times,
    keyCode,
    postRoomOnCheckIn,
    roomChargeCode,
  }
}

// เงื่อนไขเดียวกับ checkRoomCanCheckIn ของ PMS
async function roomCheckInBlock(pool, roomNo, resvNo) {
  const result = await pool.request()
    .input('RoomNo', sql.VarChar(7), roomNo)
    .query(`SELECT TOP 1 LTRIM(RTRIM(RmStatus)) AS RmStatus, ResvNo FROM RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RoomNo`)
  const room = result.recordset?.[0]
  if (!room) return `ไม่พบข้อมูลห้อง ${roomNo}`
  const status = trim(room.RmStatus).toUpperCase()
  if (status === 'CI') {
    return Number(room.ResvNo) === Number(resvNo) ? '' : 'ห้องมีคนเช็คอินอยู่ ไม่สามารถเช็คอินได้'
  }
  if (['VC', 'VD', 'OOO'].includes(status)) {
    const sale = await pool.request()
      .input('Code', sql.VarChar(10), status)
      .query(`SELECT TOP 1 RmStatusSale FROM RmStatusCode WHERE RmStatusCode = @Code`)
    const row = sale.recordset?.[0]
    if (!row) return `ไม่พบการตั้งค่าสถานะห้อง ${status}`
    return trim(row.RmStatusSale).toUpperCase() === 'T' ? '' : `ห้องสถานะ ${status} ไม่อนุญาตให้เช็คอิน`
  }
  return `ห้องสถานะ ${status || '-'} ไม่อนุญาตให้เช็คอิน`
}

async function loadCheckInContext(pool, { dbName, hotelID, resvNo, roomNo }) {
  const reservationNo = Number(resvNo)
  const room = trim(roomNo)
  if (!Number.isInteger(reservationNo) || reservationNo <= 0) throw fail('ไม่พบเลขจองของรายการนี้')
  if (!room) throw fail('ไม่ได้ระบุห้อง')

  const result = await pool.request()
    .input('ResvNo', sql.Int, reservationNo)
    .query(`
      SELECT *,
        CONVERT(varchar(10), ArrivalDate, 23) AS ArrivalYmd,
        CONVERT(varchar(10), DeptDate, 23) AS DeptYmd,
        CONVERT(varchar(8), ArrivalTime, 108) AS ArrivalHms,
        CONVERT(varchar(8), DeptTime, 108) AS DeptHms
      FROM Reservation
      WHERE ResvNo = @ResvNo AND GstNo > 0 AND Status <> 'CO'
      ORDER BY GstNo
    `)
  const rows = result.recordset || []
  if (!rows.length) throw fail('ไม่พบการจองนี้ใน PMS', 404)

  const main = rows.find((row) => Number(row.RoomCount) === 1) || rows[0]
  const rowHotel = Number(main.HotelId)
  if (rowHotel > 0 && rowHotel !== Number(hotelID)) throw fail('ไม่พบการจองนี้ใน PMS', 404)

  const sysDate = (await getKioskSysDate({ dbName, hotelID })) || todayBangkok()
  const pending = rows.filter((row) => trim(row.Status).toUpperCase() !== 'CI')
  const arrival = trim(main.ArrivalYmd)
  const departure = trim(main.DeptYmd)

  let block = ''
  if (rows.some((row) => isGroupResv(row.GroupResv))) {
    block = 'การจองแบบกรุ๊ป กรุณาเช็คอินจาก PMS'
  } else if (roomKey(main.RoomNo) !== roomKey(room)) {
    block = `การจองนี้ไม่ได้ผูกกับห้อง ${room}`
  } else if (trim(main.ResvStatus).toUpperCase() === 'CXL') {
    block = 'การจองนี้ถูกยกเลิกแล้ว'
  } else if (!pending.length) {
    block = 'การจองนี้เช็คอินแล้ว'
  } else if (!arrival || !departure) {
    block = 'การจองนี้ยังไม่มีวันที่เข้าพักหรือวันที่ออก'
  } else if (arrival > sysDate) {
    block = `ยังไม่ถึงวันเข้าพัก (เข้าพัก ${arrival.slice(8)}/${arrival.slice(5, 7)}/${arrival.slice(0, 4)})`
  } else {
    block = await roomCheckInBlock(pool, room, reservationNo)
  }

  return { reservationNo, room, rows, main, pending, sysDate, arrival, departure, block }
}

function missingCheckInFields(main) {
  return CHECKIN_FIELDS.filter((field) => {
    if (field.type === 'number') return !(Number(main[field.column]) >= 1)
    return !trim(main[field.column])
  })
}

async function getCheckInInfo({ dbName, hotelID, resvNo, roomNo }) {
  const pool = await connectDynamicDB(dbName)
  try {
    const context = await loadCheckInContext(pool, { dbName, hotelID, resvNo, roomNo })
    const lookups = await checkInLookups(pool)
    const { main } = context
    const nights = context.arrival && context.departure
      ? Math.max(1, Math.round((Date.parse(`${context.departure}T00:00:00Z`) - Date.parse(`${context.arrival}T00:00:00Z`)) / 86400000))
      : 0
    const mainCheckedIn = trim(main.Status).toUpperCase() === 'CI'
    return {
      resvNo: String(context.reservationNo),
      roomNo: context.room,
      guest: [trim(main.GstTitle), trim(main.GstFName), trim(main.GstLName)].filter(Boolean).join(' '),
      phone: trim(main.TelNo),
      agent: trim(main.GstAgent),
      memo: trim(main.Memo1),
      arrival: context.arrival,
      departure: context.departure,
      nights,
      adults: Number(main.GstAdult) || 0,
      children: Number(main.GstChildren) || 0,
      rate: money(main.RoomRateAmt),
      guests: context.rows.length,
      pending: context.pending.length,
      sysDate: context.sysDate,
      checkedIn: mainCheckedIn,
      canCheckIn: !context.block,
      blockReason: context.block,
      edit: {
        allowed: !editBlock(context),
        reason: editBlock(context),
        fields: editableFields(main, lookups),
      },
      missing: missingCheckInFields(main).map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        size: field.size || null,
        options: field.type === 'select' ? lookups.options[field.key] || [] : null,
        value: field.type === 'number' ? 1 : (lookups.defaults[field.key] || ''),
      })),
      paidBy: {
        locked: mainCheckedIn,
        options: lookups.paidBy,
        value: lookups.paidBy.some((row) => row.code === trim(main.PaymentType)) ? trim(main.PaymentType) : '',
        amount: money(main.DepositAmt),
        reference: trim(main.Reference),
        keyCode: lookups.keyCode,
        keyAmount: lookups.keyCode ? money(main.DepositKeyAmt) : 0,
      },
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function saveGuestHistory(pool, guest, hotelID) {
  await pool.request()
    .input('GuestID', sql.Int, 0)
    .input('GroupResv', sql.SmallInt, Number(guest.GroupResv) || 0)
    .input('FName', sql.VarChar(100), guest.GstFName ?? '')
    .input('LName', sql.VarChar(100), guest.GstLName ?? '')
    .input('TitleName', sql.VarChar(30), guest.GstTitle ?? '')
    .input('Company', sql.VarChar(100), guest.Company ?? '')
    .input('Position', sql.VarChar(32), ' ')
    .input('Birthday', sql.DateTime, guest.Birthday ?? null)
    .input('Passport', sql.VarChar(20), guest.GstPassPortNo ?? '')
    .input('Nation', sql.VarChar(3), guest.GstNation ?? '')
    .input('Agent', sql.VarChar(10), guest.GstAgent ?? '')
    .input('GstType', sql.VarChar(3), guest.GstType ?? '')
    .input('GstLevel', sql.VarChar(3), guest.GstLevel ?? '')
    .input('BussSource', sql.VarChar(5), guest.GstBusSource ?? '')
    .input('MarketCode', sql.VarChar(5), guest.GstMarketCode ?? '')
    .input('Address1', sql.VarChar(64), guest.Address1 ?? '')
    .input('Address2', sql.VarChar(64), guest.Address2 ?? '')
    .input('Address3', sql.VarChar(64), guest.Address3 ?? '')
    .input('Tel1', sql.VarChar(32), guest.TelNo ?? '')
    .input('Tel2', sql.VarChar(32), ' ')
    .input('Fax', sql.VarChar(32), ' ')
    .input('email', sql.VarChar(64), guest.EMAIL ?? '')
    .input('remark', sql.VarChar(255), guest.Memo1 ?? '')
    .input('arr1', sql.DateTime, guest.ArrivalDate ?? null)
    .input('dept1', sql.DateTime, guest.DeptDate ?? null)
    .input('room1', sql.VarChar(7), guest.RoomNo ?? '')
    .input('rate1', sql.Float, Number(guest.RoomRateAmt) || 0)
    .input('Abf1', sql.Float, Number(guest.AbfAmt) || 0)
    .input('NetAmt', sql.Float, 0)
    .input('Bonus', sql.Int, 0)
    .input('BonusUsed', sql.Int, 0)
    .input('BonusNet', sql.Int, 0)
    .input('MemberNo', sql.VarChar(10), guest.MemberCardNo ?? '')
    .input('RoomNo', sql.VarChar(7), guest.RoomNo ?? '')
    .input('TypeOfPayment', sql.VarChar(5), guest.PaymentType ?? '')
    .input('Recommend', sql.VarChar(255), guest.Memo2 ?? '')
    .input('BlackList', sql.VarChar(255), guest.Memo3 ?? '')
    .input('TaxId', sql.VarChar(100), guest.TaxId ?? '')
    .input('homeAdd1', sql.VarChar(64), guest.HomeAddress1 ?? '')
    .input('homeAdd2', sql.VarChar(64), guest.HomeAddress2 ?? '')
    .input('homeAdd3', sql.VarChar(64), guest.HomeAddress3 ?? '')
    .input('HotelID', sql.Int, Number(guest.HotelId) || Number(hotelID))
    .input('NationCardId', sql.VarChar(16), guest.NationCardId ?? '')
    .input('FileImage', sql.VarChar(100), guest.FileImage ?? '')
    .input('Sex', sql.VarChar(8), guest.Sex ?? '')
    .execute('Sp_SaveGuestHistory_theOtel')
}

async function postCheckInDeposit(pool, { main, room, reservationNo, hotelID, user, sysDate, arrival, amount, trnCode, reference }) {
  await pool.request()
    .input('roomno', sql.VarChar(7), room)
    .input('amt', sql.Float, amount)
    .input('bussdate', sql.DateTime, dateParam(sysDate))
    .input('userid', sql.VarChar(20), user)
    .input('shiftno', sql.SmallInt, 1)
    .input('ref', sql.VarChar(16), trim(reference).slice(0, 16))
    .input('TrnCode', sql.VarChar(5), trnCode)
    .input('gstName', sql.VarChar(76), trim(main.GstFName))
    .input('CIDate', sql.VarChar(16), arrival)
    .output('id', sql.Int, 2)
    .input('ResvNo', sql.Int, reservationNo)
    .input('MemberId', sql.VarChar(20), '')
    .input('CurrencyCode', sql.VarChar(5), '')
    .input('CurrencyRate', sql.Float, 0)
    .input('CurrencyAmt', sql.Float, 0)
    .input('VoucherNo', sql.VarChar(24), trim(main.VoucherNo))
    .input('AgentCode', sql.VarChar(16), trim(main.GstAgent))
    .input('HotelId', sql.Int, Number(hotelID))
    .execute('sp_postdeposit')
}

/**
 * เช็คอินตามลำดับของ PMS: เติมข้อมูลที่ขาด → Sp_ReservationCheckIn → ประวัติแขก
 * → โพสต์ค่าห้องอัตโนมัติ (ถ้า PMS ตั้งไว้) → มัดจำตาม Paid by (ถ้าเลือก)
 */
async function checkInReservation({ dbName, hotelID, resvNo, roomNo, userId, fill, paidBy, depositAmount, reference, keyAmount }) {
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const values = fill && typeof fill === 'object' ? fill : {}
  const pool = await connectDynamicDB(dbName)
  try {
    const context = await loadCheckInContext(pool, { dbName, hotelID, resvNo, roomNo })
    if (context.block) throw fail(context.block)
    const lookups = await checkInLookups(pool)
    const { main, room, reservationNo } = context
    const mainCheckedIn = trim(main.Status).toUpperCase() === 'CI'

    // 1) ข้อมูลที่ขาด — รับเฉพาะช่องที่ว่างอยู่จริง และไม่ทับข้อมูลเดิม
    const updates = []
    const stillMissing = []
    for (const field of missingCheckInFields(main)) {
      if (field.type === 'number') {
        const count = Math.floor(Number(values[field.key]))
        if (!(count >= 1 && count <= 99)) { stillMissing.push(field.label); continue }
        updates.push({ field, value: count })
        continue
      }
      const text = trim(values[field.key]).slice(0, field.size)
      if (!text) { stillMissing.push(field.label); continue }
      const choices = field.type === 'select' ? lookups.options[field.key] || [] : []
      if (choices.length && !choices.some((row) => row.code === text)) {
        throw fail(`${field.label} ไม่ถูกต้อง`)
      }
      updates.push({ field, value: text })
    }
    if (stillMissing.length) {
      const error = fail(`กรอกข้อมูลให้ครบก่อนเช็คอิน: ${stillMissing.join(', ')}`)
      error.missing = stillMissing
      throw error
    }

    // 2) Paid by เลือกหรือไม่เลือกก็ได้ แต่ถ้ารับเงินต้องระบุ
    const payCode = trim(paidBy)
    const deposit = mainCheckedIn ? 0 : money(depositAmount)
    const keyDeposit = mainCheckedIn || !lookups.keyCode ? 0 : money(keyAmount)
    if (deposit < 0 || keyDeposit < 0) throw fail('จำนวนเงินต้องไม่ติดลบ')
    if (payCode && !lookups.paidBy.some((row) => row.code === payCode)) throw fail('Paid by ไม่ถูกต้อง')
    if (deposit > 0 && !payCode) throw fail('เลือก Paid by ก่อนรับเงินมัดจำ')

    if (updates.length) {
      const request = pool.request().input('ResvNo', sql.Int, reservationNo)
      const sets = updates.map(({ field, value }) => {
        if (field.type === 'number') {
          request.input(field.column, sql.Int, value)
          return `${field.column} = CASE WHEN ISNULL(${field.column}, 0) < 1 THEN @${field.column} ELSE ${field.column} END`
        }
        request.input(field.column, sql.VarChar(field.size), value)
        return `${field.column} = CASE WHEN LTRIM(RTRIM(ISNULL(${field.column}, ''))) = '' THEN @${field.column} ELSE ${field.column} END`
      })
      await request.query(`
        UPDATE Reservation SET ${sets.join(', ')}
        WHERE ResvNo = @ResvNo AND GstNo > 0 AND Status <> 'CO'
      `)
    }
    if (!mainCheckedIn && payCode) {
      await pool.request()
        .input('ResvNo', sql.Int, reservationNo)
        .input('PaymentType', sql.VarChar(5), payCode)
        .query(`
          UPDATE Reservation SET PaymentType = @PaymentType
          WHERE ResvNo = @ResvNo AND GstNo > 0 AND Status <> 'CO'
        `)
    }

    // 3) เช็คอินผู้เข้าพักที่ยังไม่ได้เช็คอินทุกคนในห้องนี้
    const arrivalHms = hmsOf(main.ArrivalHms) || lookups.times.arrival || '14:00:00'
    const departureHms = hmsOf(main.DeptHms) || lookups.times.departure || '12:00:00'
    const warnings = []
    let checkedIn = 0
    for (const guest of context.pending) {
      const gstNo = Number(guest.GstNo)
      await pool.request()
        .input('ResvNo', sql.Int, reservationNo)
        .input('GstNo', sql.Int, gstNo)
        .input('RoomNo', sql.VarChar(7), room)
        .input('CheckInCode', sql.VarChar(3), 'CI')
        .input('ArrivalDate', sql.DateTime, dateParam(context.arrival))
        .input('ArrivalTime', sql.DateTime, timeParam(arrivalHms))
        .input('DeptDate', sql.DateTime, dateParam(context.departure))
        .input('DeptTime', sql.DateTime, timeParam(departureHms))
        .input('Memo1', sql.VarChar(255), '')
        .input('Memo2', sql.VarChar(255), '')
        .input('UserID', sql.VarChar(20), user)
        .input('SysDate', sql.DateTime, dateParam(context.sysDate))
        .input('ShiftNo', sql.SmallInt, 1)
        .input('HotelID', sql.Int, Number(hotelID))
        .input('GroupName', sql.VarChar(255), '')
        .input('RhinopmsId', sql.SmallInt, 2)
        .execute('Sp_ReservationCheckIn')
      checkedIn += 1

      let fresh = null
      try {
        const reread = await pool.request()
          .input('ResvNo', sql.Int, reservationNo)
          .input('GstNo', sql.Int, gstNo)
          .query('SELECT TOP 1 * FROM Reservation WHERE ResvNo = @ResvNo AND GstNo = @GstNo')
        fresh = reread.recordset?.[0] || null
        if (fresh) await saveGuestHistory(pool, fresh, hotelID)
      } catch (err) {
        warnings.push(`บันทึกประวัติแขกไม่สำเร็จ: ${err.message}`)
      }

      if (lookups.postRoomOnCheckIn && lookups.roomChargeCode && fresh && Number(fresh.RoomCount) === 1) {
        try {
          await pool.request()
            .input('RmNo', sql.VarChar(7), fresh.RoomNo ?? '')
            .input('ChgAmt', sql.Float, Number(fresh.RoomRateAmt) || 0)
            .input('userid', sql.VarChar(20), user)
            .input('ShiftNo', sql.SmallInt, 1)
            .input('Ref', sql.VarChar(16), 'C-I')
            .input('TrnCode', sql.VarChar(5), lookups.roomChargeCode)
            .input('HotelID', sql.Int, Number(hotelID))
            .execute('Sp_AutoPostRoomCheckIn')
        } catch (err) {
          warnings.push(`โพสต์ค่าห้องอัตโนมัติไม่สำเร็จ: ${err.message}`)
        }
      }
    }

    // 4) มัดจำตาม Paid by — ทำครั้งเดียวตอนแขกหลักเช็คอิน เหมือน PMS
    const deposits = { base: { main, room, reservationNo, hotelID, user, sysDate: context.sysDate, arrival: context.arrival } }
    if (deposit > 0) {
      try {
        await postCheckInDeposit(pool, { ...deposits.base, amount: deposit, trnCode: payCode, reference })
        try {
          await pool.request()
            .input('ResvNo', sql.Int, reservationNo)
            .input('DepositAmt', sql.Float, deposit)
            .input('Reference', sql.VarChar(40), trim(reference).slice(0, 40))
            .query(`
              UPDATE Reservation SET DepositAmt = @DepositAmt, Reference = @Reference
              WHERE ResvNo = @ResvNo AND GstNo > 0 AND Status <> 'CO'
            `)
        } catch { /* ยอดถูกโพสต์แล้ว แค่ช่องแสดงผลใน PMS ไม่อัปเดต */ }
      } catch (err) {
        warnings.push(`รับเงินมัดจำไม่สำเร็จ: ${err.message}`)
      }
    }
    if (keyDeposit > 0) {
      try {
        await postCheckInDeposit(pool, { ...deposits.base, amount: keyDeposit, trnCode: lookups.keyCode, reference: 'C/I' })
      } catch (err) {
        warnings.push(`รับมัดจำคีย์การ์ดไม่สำเร็จ: ${err.message}`)
      }
    }

    return { ok: true, roomNo: room, resvNo: String(reservationNo), checkedIn, warnings }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

// ฟิลด์ที่แก้ได้จากปฏิทิน เท่ากับหน้า Individual Check-In ของ PMS (บันทึกด้วย Sp_ReservationAppend)
// lockWhenCi = ช่องที่ PMS ปิดหลังเช็คอิน (ห้อง ประเภทห้อง มัดจำ ฯลฯ) — ชื่อยังแก้ได้เหมือน PMS
const EDIT_FIELDS = [
  { key: 'arrival', column: 'ArrivalYmd', label: 'วันเช็คอิน', type: 'date', group: 'stay', scope: 'booking', required: true },
  { key: 'departure', column: 'DeptYmd', label: 'วันเช็คเอาต์', type: 'date', group: 'stay', scope: 'booking', required: true },
  { key: 'arrivalTime', column: 'ArrivalHms', label: 'เวลาเข้า', type: 'time', group: 'stay', scope: 'booking', size: 8 },
  { key: 'departureTime', column: 'DeptHms', label: 'เวลาออก', type: 'time', group: 'stay', scope: 'booking', size: 8 },
  { key: 'roomNo', column: 'RoomNo', label: 'เลขห้อง', type: 'text', group: 'stay', scope: 'booking', size: 7, lockWhenCi: true, required: true },
  { key: 'roomType', column: 'RoomType', label: 'ประเภทห้อง', type: 'select', group: 'stay', scope: 'booking', size: 5, lockWhenCi: true, required: true },
  { key: 'roomFeature', column: 'RoomFeature', label: 'คุณสมบัติห้อง', type: 'select', group: 'stay', scope: 'booking', size: 20, lockWhenCi: true },
  { key: 'resvStatus', column: 'ResvStatus', label: 'สถานะจอง', type: 'select', group: 'stay', scope: 'booking', size: 3 },
  { key: 'title', column: 'GstTitle', label: 'คำนำหน้า', type: 'select', group: 'guest', scope: 'guest', size: 16 },
  { key: 'firstName', column: 'GstFName', label: 'ชื่อ', type: 'text', group: 'guest', scope: 'guest', size: 30, required: true },
  { key: 'lastName', column: 'GstLName', label: 'นามสกุล', type: 'text', group: 'guest', scope: 'guest', size: 30 },
  { key: 'sex', column: 'Sex', label: 'เพศ', type: 'select', group: 'guest', scope: 'guest', size: 8 },
  { key: 'birthday', column: 'Birthday', label: 'วันเกิด', type: 'date', group: 'guest', scope: 'guest' },
  { key: 'nation', column: 'GstNation', label: 'สัญชาติ', type: 'select', group: 'guest', scope: 'guest', size: 3, required: true },
  { key: 'cardId', column: 'NationCardId', label: 'เลขบัตรประชาชน', type: 'text', group: 'guest', scope: 'guest', size: 16 },
  { key: 'passport', column: 'GstPassPortNo', label: 'พาสปอร์ต', type: 'text', group: 'guest', scope: 'guest', size: 30 },
  { key: 'phone', column: 'TelNo', label: 'เบอร์โทร', type: 'text', group: 'guest', scope: 'guest', size: 24 },
  { key: 'email', column: 'EMAIL', label: 'อีเมล', type: 'text', group: 'guest', scope: 'guest', size: 64 },
  { key: 'address1', column: 'HomeAddress1', label: 'ที่อยู่ 1', type: 'text', group: 'guest', scope: 'guest', size: 64 },
  { key: 'address2', column: 'HomeAddress2', label: 'ที่อยู่ 2', type: 'text', group: 'guest', scope: 'guest', size: 64 },
  { key: 'address3', column: 'HomeAddress3', label: 'ที่อยู่ 3', type: 'text', group: 'guest', scope: 'guest', size: 64 },
  { key: 'agent', column: 'GstAgent', label: 'เอเจนต์', type: 'select', group: 'codes', scope: 'booking', size: 10 },
  { key: 'voucher', column: 'VoucherNo', label: 'เลขวอยเชอร์', type: 'text', group: 'codes', scope: 'booking', size: 25 },
  { key: 'market', column: 'GstMarketCode', label: 'ตลาดลูกค้า', type: 'select', group: 'codes', scope: 'booking', size: 5, required: true },
  { key: 'source', column: 'GstBusSource', label: 'แหล่งที่มา', type: 'select', group: 'codes', scope: 'booking', size: 5, required: true },
  { key: 'guestType', column: 'GstType', label: 'ประเภทลูกค้า', type: 'select', group: 'codes', scope: 'booking', size: 3, required: true },
  { key: 'guestLevel', column: 'GstLevel', label: 'ระดับลูกค้า', type: 'select', group: 'codes', scope: 'booking', size: 3, required: true },
  { key: 'adults', column: 'GstAdult', label: 'ผู้ใหญ่', type: 'number', group: 'rate', scope: 'booking', min: 1 },
  { key: 'children', column: 'GstChildren', label: 'เด็ก', type: 'number', group: 'rate', scope: 'booking', min: 0 },
  { key: 'rate', column: 'RoomRateAmt', label: 'ราคาห้อง / คืน', type: 'money', group: 'rate', scope: 'booking', min: 0 },
  { key: 'abfAdult', column: 'AbfAdult', label: 'จำนวน ABF ผู้ใหญ่', type: 'number', group: 'rate', scope: 'booking', min: 0 },
  { key: 'abfAmt', column: 'AbfAmt', label: 'ราคา ABF ผู้ใหญ่', type: 'money', group: 'rate', scope: 'booking', min: 0 },
  { key: 'abfChild', column: 'QtyAbfChild', label: 'จำนวน ABF เด็ก', type: 'number', group: 'rate', scope: 'booking', min: 0 },
  { key: 'abfChildAmt', column: 'AbfChildAmt', label: 'ราคา ABF เด็ก', type: 'money', group: 'rate', scope: 'booking', min: 0 },
  { key: 'paidBy', column: 'PaymentType', label: 'Paid by', type: 'select', group: 'payment', scope: 'booking', size: 5, lockWhenCi: true },
  { key: 'deposit', column: 'DepositAmt', label: 'มัดจำห้อง', type: 'money', group: 'payment', scope: 'booking', min: 0, lockWhenCi: true },
  { key: 'depositKey', column: 'DepositKeyAmt', label: 'มัดจำคีย์การ์ด', type: 'money', group: 'payment', scope: 'booking', min: 0, lockWhenCi: true },
  { key: 'reference', column: 'Reference', label: 'อ้างอิง', type: 'text', group: 'payment', scope: 'booking', size: 40, lockWhenCi: true },
  { key: 'chargeTo', column: 'Chargeto', label: 'Charge to', type: 'text', group: 'payment', scope: 'booking', size: 32 },
  { key: 'creditLimit', column: 'CreditLimit', label: 'วงเงินเครดิต', type: 'money', group: 'payment', scope: 'booking', min: 0 },
  { key: 'memo', column: 'Memo1', label: 'หมายเหตุ', type: 'textarea', group: 'note', scope: 'booking', size: 255 },
  { key: 'memo2', column: 'Memo2', label: 'หมายเหตุ 2', type: 'textarea', group: 'note', scope: 'booking', size: 255 },
]

function isCheckedIn(row) {
  return trim(row?.Status).toUpperCase() === 'CI'
}

function editBlock(context) {
  const { main, rows, room } = context
  if (rows.some((row) => isGroupResv(row.GroupResv))) return 'การจองแบบกรุ๊ป กรุณาแก้ไขจาก PMS'
  if (roomKey(main.RoomNo) !== roomKey(room)) return `การจองนี้ไม่ได้ผูกกับห้อง ${room}`
  if (trim(main.ResvStatus).toUpperCase() === 'CXL') return 'การจองนี้ถูกยกเลิกแล้ว'
  return ''
}

function nightsBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
}

function thaiDate(ymd) {
  return `${ymd.slice(8)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`
}

function fieldCurrent(main, field) {
  if (field.type === 'number') return Number(main[field.column]) || 0
  if (field.type === 'money') return money(main[field.column])
  if (field.key === 'birthday') {
    const value = main.Birthday
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
    const text = String(value || '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
  }
  return trim(main[field.column])
}

function editableFields(main, lookups) {
  const checkedIn = isCheckedIn(main)
  return EDIT_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    group: field.group,
    size: field.size || null,
    min: field.min != null ? field.min : null,
    required: Boolean(field.required),
    locked: Boolean(field.lockWhenCi) && checkedIn,
    options: field.type === 'select' ? lookups.options[field.key] || [] : null,
    value: fieldCurrent(main, field),
  }))
}

function normalizeTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || 0)
  if (hour > 23 || minute > 59 || second > 59) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

async function assertRoomVacant(pool, { hotelID, roomNo, arrival, departure, resvNo }) {
  const room = trim(roomNo).toUpperCase()
  const exists = await pool.request()
    .input('RoomNo', sql.VarChar(7), room)
    .input('HotelId', sql.Int, Number(hotelID))
    .query(`
      SELECT TOP 1 LTRIM(RTRIM(RmNum)) AS RoomNo, LTRIM(RTRIM(RmType)) AS RoomType, LTRIM(RTRIM(RmFeature)) AS RoomFeature
      FROM RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RoomNo AND HotelID = @HotelId
    `)
  const setup = exists.recordset?.[0]
  if (!setup) throw fail(`ไม่พบห้อง ${room} ใน PMS`)

  // เงื่อนไขเดียวกับ checkRoomVacant ของ PMS: มีการจองอื่นในห้องนี้ที่ยังไม่ออก และวันออกช้ากว่าวันเข้าใหม่
  const conflict = await pool.request()
    .input('ResvNo', sql.Int, Number(resvNo))
    .input('RoomNo', sql.VarChar(7), room)
    .input('Arrival', sql.DateTime, dateParam(arrival))
    .input('Departure', sql.DateTime, dateParam(departure))
    .query(`
      SELECT TOP 1 ResvNo, LTRIM(RTRIM(RoomNo)) AS RoomNo,
        CONVERT(varchar(10), ArrivalDate, 23) AS ArrivalYmd,
        CONVERT(varchar(10), DeptDate, 23) AS DeptYmd,
        LTRIM(RTRIM(Status)) AS Status
      FROM Reservation
      WHERE ResvNo <> @ResvNo
        AND RoomCount = 1
        AND LTRIM(RTRIM(RoomNo)) = @RoomNo
        AND ResvStatus <> 'CXL'
        AND Status <> 'CO'
        AND ArrivalDate < @Departure
        AND DeptDate > @Arrival
      ORDER BY ArrivalDate
    `)
  const row = conflict.recordset?.[0]
  if (row) {
    throw fail(`ห้อง ${room} ไม่ว่าง ${thaiDate(row.ArrivalYmd)} → ${thaiDate(row.DeptYmd)} (เลขจอง ${row.ResvNo})`)
  }
  return setup
}

function ymdOf(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const text = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

// บันทึกแบบ PMS: Sp_ReservationAppend — RecState 1=ใหม่, 2=แก้ไข
async function appendReservation(pool, guest, patch, { hotelID, user, recState = 2 }) {
  const arrival = patch.ArrivalYmd || ymdOf(guest.ArrivalDate) || trim(guest.ArrivalYmd)
  const departure = patch.DeptYmd || ymdOf(guest.DeptDate) || trim(guest.DeptYmd)
  const arrivalHms = patch.ArrivalHms || hmsOf(guest.ArrivalTime) || trim(guest.ArrivalHms) || '14:00:00'
  const departureHms = patch.DeptHms || hmsOf(guest.DeptTime) || trim(guest.DeptHms) || '12:00:00'
  const nights = arrival && departure ? Math.max(1, nightsBetween(arrival, departure)) : Number(guest.StayDay) || 0
  const birthday = Object.prototype.hasOwnProperty.call(patch, 'Birthday')
    ? (patch.Birthday ? dateParam(patch.Birthday) : null)
    : (guest.Birthday instanceof Date && !Number.isNaN(guest.Birthday.getTime()) ? guest.Birthday : null)
  const value = (column, fallback = '') => (
    Object.prototype.hasOwnProperty.call(patch, column) ? patch[column] : (guest[column] ?? fallback)
  )
  const text = (column, fallback = '') => trim(value(column, fallback))
  const num = (column, fallback = 0) => {
    const raw = value(column, fallback)
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  const state = Number(recState) === 1 ? 1 : 2
  const roomCount = state === 1 ? 1 : (Number(guest.RoomCount) === 1 ? 1 : 0)

  await pool.request()
    .input('RecState', sql.Int, state)
    .input('ResvNo', sql.Int, Number(guest.ResvNo))
    .input('OTABookingNo', sql.VarChar(20), text('OTABookingNo'))
    .input('GstNo', sql.Int, Number(guest.GstNo) || 1)
    .input('ResvDate', sql.DateTime, guest.ResvDate || dateParam(ymdOf(new Date())) || null)
    .input('GstFName', sql.VarChar(30), text('GstFName'))
    .input('GstLName', sql.VarChar(30), text('GstLName'))
    .input('GStTitle', sql.VarChar(16), text('GstTitle'))
    .input('GstNation', sql.VarChar(3), text('GstNation'))
    .input('GstAgent', sql.VarChar(10), text('GstAgent'))
    .input('GstType', sql.VarChar(3), text('GstType'))
    .input('GstLevel', sql.VarChar(3), text('GstLevel'))
    .input('GstBusSource', sql.VarChar(5), text('GstBusSource'))
    .input('GstMarketCode', sql.VarChar(5), text('GstMarketCode'))
    .input('ResvType', sql.VarChar(3), text('ResvType', ' '))
    .input('ResvStatus', sql.VarChar(3), text('ResvStatus'))
    .input('GstAdult', sql.Int, num('GstAdult'))
    .input('GstChildren', sql.SmallInt, num('GstChildren'))
    .input('StayDay', sql.SmallInt, nights)
    .input('ArrivalDate', sql.DateTime, dateParam(arrival))
    .input('ArrivalTime', sql.DateTime, timeParam(arrivalHms))
    .input('ArrivalBy', sql.VarChar(2), text('ArrivalBy', ' '))
    .input('ArrivalFlgDetail', sql.VarChar(10), text('ArrivalFlgDetail', ' '))
    .input('ArrServiceBy', sql.VarChar(3), text('ArrServiceBy', ' '))
    .input('DeptDate', sql.DateTime, dateParam(departure))
    .input('DeptTime', sql.DateTime, timeParam(departureHms))
    .input('DeptBy', sql.VarChar(2), text('DeptBy', ' '))
    .input('DeptFlgDetail', sql.VarChar(10), text('DeptFlgDetail', ' '))
    .input('DeptServiceBy', sql.VarChar(3), text('DeptServiceBy', ' '))
    .input('RoomCount', sql.SmallInt, roomCount)
    .input('RoomType', sql.VarChar(5), text('RoomType'))
    .input('RoomRateCode', sql.VarChar(7), text('RoomRateCode', ' '))
    .input('RoomRateAmt', sql.Float, num('RoomRateAmt'))
    .input('RoomFeature', sql.VarChar(20), text('RoomFeature'))
    .input('RoomNo', sql.VarChar(7), text('RoomNo'))
    .input('DepositAmt', sql.Float, num('DepositAmt'))
    .input('PaymentType', sql.VarChar(5), text('PaymentType'))
    .input('CreditLimit', sql.Float, num('CreditLimit'))
    .input('Reference', sql.VarChar(40), text('Reference'))
    .input('CardApprove', sql.VarChar(10), text('CardApprove', ' '))
    .input('CardExpire', sql.DateTime, guest.CardExpire || null)
    .input('GstHistory', sql.VarChar(1), text('GstHistory', 'Y'))
    .input('Comp', sql.VarChar(1), text('Comp', 'N'))
    .input('Memo1', sql.VarChar(255), text('Memo1'))
    .input('Memo2', sql.VarChar(255), text('Memo2'))
    .input('User', sql.VarChar(20), user)
    .input('Date', sql.DateTime, new Date())
    .input('ResvName', sql.VarChar(48), text('ResvName'))
    .input('GstPassPortNo', sql.VarChar(30), text('GstPassPortNo'))
    .input('yyyyBirthday', sql.VarChar(4), text('yyyyBirthday', ' '))
    .input('Sex', sql.VarChar(8), text('Sex'))
    .input('Visa', sql.VarChar(32), text('Visa', ' '))
    .input('visaBgDate', sql.DateTime, guest.visaBgDate || null)
    .input('visaenddate', sql.DateTime, guest.visaenddate || null)
    .input('tmno', sql.VarChar(32), text('tmno', ' '))
    .input('PointOfEntry', sql.VarChar(10), text('PointOfEntry', ' '))
    .input('add1', sql.VarChar(64), text('Address1'))
    .input('add2', sql.VarChar(64), text('Address2'))
    .input('add3', sql.VarChar(64), text('Address3'))
    .input('AbfAmt', sql.Float, num('AbfAmt'))
    .input('ExtraBed', sql.Float, num('ExtraBed'))
    .input('Telno', sql.VarChar(24), text('TelNo'))
    .input('Email', sql.VarChar(64), text('EMAIL'))
    .input('Company', sql.VarChar(100), text('Company'))
    .input('Birthday', sql.DateTime, birthday)
    .input('Chargeto', sql.VarChar(32), text('Chargeto'))
    .input('PrnRate', sql.VarChar(1), text('PrnRate', 'N'))
    .input('ArrCount', sql.Int, num('ArrCount'))
    .input('AmtUsed', sql.Float, num('AmtUsed'))
    .input('Memo3', sql.VarChar(255), text('Memo3'))
    .input('AuthAmt', sql.Float, num('AuthAmt'))
    .input('AuthPaidBy', sql.VarChar(5), text('AuthPaidBy', ' '))
    .input('AuthRef', sql.VarChar(32), text('AuthRef', ' '))
    .input('GstPictName', sql.VarChar(32), text('GstPictName'))
    .input('FileImage', sql.VarChar(50), text('FileImage'))
    .input('RegistNo', sql.VarChar(10), text('RegistNo', ' '))
    .input('HomeAdd1', sql.VarChar(64), text('HomeAddress1'))
    .input('HomeAdd2', sql.VarChar(64), text('HomeAddress2'))
    .input('HomeAdd3', sql.VarChar(64), text('HomeAddress3'))
    .input('FolioPrintNo', sql.SmallInt, Number(guest.FolioPrintNo) || 1)
    .input('SaleID', sql.VarChar(20), text('SaleID', ' '))
    .input('Rackrate', sql.Float, num('RackRate'))
    .input('DiscPecent', sql.Int, num('DiscountPercent') || num('DiscPecent'))
    .input('DiscBaht', sql.Float, num('DiscountBaht') || num('DiscBaht'))
    .input('AbfAdult', sql.Int, num('AbfAdult'))
    .input('QtyAbfChild', sql.Int, num('QtyAbfChild'))
    .input('AbfChildAmt', sql.Float, num('AbfChildAmt'))
    .input('ExtraBedCount', sql.Int, num('ExtraBedCount'))
    .input('BabyCotCount', sql.SmallInt, num('BabyCotCount'))
    .input('BabyCotAmt', sql.Float, num('BabyCotAmt'))
    .input('ExtraBedAbfAmt', sql.Float, num('ExtraBedAbfAmt'))
    .input('BabyCotAbfAmt', sql.Float, num('BabyCotAbfAmt'))
    .input('ShiftNo', sql.SmallInt, 1)
    .input('TaxId', sql.VarChar(32), text('TaxId'))
    .input('CarId', sql.VarChar(16), text('CarNo') || text('CarId'))
    .input('VoucherNo', sql.VarChar(25), text('VoucherNo'))
    .input('DepositKeyAmt', sql.Float, num('DepositKeyAmt'))
    .input('NationCardID', sql.VarChar(16), text('NationCardId'))
    .input('HotelId', sql.Int, Number(guest.HotelId) || Number(hotelID))
    .execute('Sp_ReservationAppend')
}

/**
 * แก้ไขข้อมูลการจองจากปฏิทิน เท่าที่ PMS แก้ได้
 * เขียนเฉพาะช่องที่ค่าเปลี่ยน แล้วบันทึกผ่าน Sp_ReservationAppend เหมือนปุ่ม Save ของ PMS
 */
async function updateReservationInfo({ dbName, hotelID, resvNo, roomNo, userId, values }) {
  const input = values && typeof values === 'object' ? values : {}
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const pool = await connectDynamicDB(dbName)
  try {
    const context = await loadCheckInContext(pool, { dbName, hotelID, resvNo, roomNo })
    const block = editBlock(context)
    if (block) throw fail(block)
    const lookups = await checkInLookups(pool)
    const { main, rows, reservationNo, sysDate } = context
    const checkedIn = isCheckedIn(main) || rows.some(isCheckedIn)

    const changes = []
    for (const field of EDIT_FIELDS) {
      if (!(field.key in input)) continue
      const current = fieldCurrent(main, field)
      let next
      if (field.type === 'number') {
        next = Math.floor(Number(input[field.key]))
        if (next === current) continue
        if (!Number.isFinite(next) || next < field.min || next > 99) {
          throw fail(`${field.label} ต้องอยู่ระหว่าง ${field.min}–99`)
        }
      } else if (field.type === 'money') {
        next = money(input[field.key])
        if (next === current) continue
        if (!(next >= field.min)) throw fail(`${field.label} ต้องไม่ติดลบ`)
      } else if (field.type === 'date') {
        next = trim(input[field.key]).slice(0, 10)
        if (next === current) continue
        if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) throw fail(`${field.label} ไม่ถูกต้อง`)
        if (!next && field.required) throw fail(`${field.label} ห้ามเว้นว่าง`)
      } else if (field.type === 'time') {
        next = normalizeTime(input[field.key])
        if ((next || '') === (normalizeTime(current) || current)) continue
        if (input[field.key] && !next) throw fail(`${field.label} ใช้รูปแบบ ชม:นาที`)
      } else {
        next = trim(input[field.key])
        if (field.key === 'roomNo') next = next.toUpperCase()
        if (next === current) continue
        if (field.size && next.length > field.size) throw fail(`${field.label} ยาวเกิน ${field.size} ตัวอักษร`)
        if (!next && field.required) throw fail(`${field.label} ห้ามเว้นว่าง`)
        const choices = field.type === 'select' ? lookups.options[field.key] || [] : []
        if (next && choices.length && !choices.some((row) => row.code === next)) {
          throw fail(`${field.label} ไม่ถูกต้อง`)
        }
      }
      if (field.lockWhenCi && checkedIn) throw fail(`แขกเช็คอินแล้ว แก้${field.label}ไม่ได้`)
      changes.push({ field, value: next })
    }
    if (!changes.length) return { ok: true, resvNo: String(reservationNo), changed: [] }

    const patch = {}
    for (const { field, value } of changes) patch[field.column] = value
    const nextArrival = patch.ArrivalYmd || trim(main.ArrivalYmd)
    const nextDeparture = patch.DeptYmd || trim(main.DeptYmd)
    const nextRoom = patch.RoomNo || trim(main.RoomNo)
    if (!nextArrival || !nextDeparture) throw fail('วันเช็คอินและวันเช็คเอาต์ต้องครบ')
    if (nextDeparture <= nextArrival) throw fail('วันเช็คเอาต์ต้องหลังวันเช็คอิน')
    if (!checkedIn && nextArrival < sysDate) {
      throw fail(`วันเช็คอินต้องไม่ก่อนวันทำการของ PMS (${thaiDate(sysDate)})`)
    }

    const stayChanged = Boolean(patch.ArrivalYmd || patch.DeptYmd || patch.RoomNo)
    if (stayChanged && trim(main.ResvStatus).toUpperCase() !== 'CXL') {
      await assertRoomVacant(pool, {
        hotelID,
        roomNo: nextRoom,
        arrival: nextArrival,
        departure: nextDeparture,
        resvNo: reservationNo,
      })
      if (patch.RoomNo && !patch.RoomType) {
        const setup = await pool.request()
          .input('RoomNo', sql.VarChar(7), nextRoom)
          .input('HotelId', sql.Int, Number(hotelID))
          .query(`SELECT TOP 1 LTRIM(RTRIM(RmType)) AS RoomType, LTRIM(RTRIM(RmFeature)) AS RoomFeature FROM RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RoomNo AND HotelID = @HotelId`)
        const row = setup.recordset?.[0]
        if (row?.RoomType && !trim(main.RoomType)) patch.RoomType = trim(row.RoomType)
        if (row?.RoomFeature && !Object.prototype.hasOwnProperty.call(patch, 'RoomFeature') && !trim(main.RoomFeature)) {
          patch.RoomFeature = trim(row.RoomFeature)
        }
      }
    }

    // แขกหลักได้ทุกช่องที่แก้ แขกร่วมได้เฉพาะช่องระดับการจอง (วันที่ ห้อง ราคา โค้ดตลาด ฯลฯ)
    for (const guest of rows) {
      const guestPatch = { ...patch }
      if (Number(guest.GstNo) !== Number(main.GstNo)) {
        for (const { field } of changes) {
          if (field.scope === 'guest') delete guestPatch[field.column]
        }
      }
      await appendReservation(pool, guest, guestPatch, { hotelID, user })
    }

    return {
      ok: true,
      resvNo: String(reservationNo),
      roomNo: nextRoom,
      arrival: nextArrival,
      departure: nextDeparture,
      changed: changes.map((change) => change.field.label),
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

function pickOption(list, preferred) {
  const rows = Array.isArray(list) ? list : []
  if (preferred && rows.some((row) => row.code === preferred)) return preferred
  return rows[0]?.code || ''
}

function pickResvStatus(list) {
  const rows = Array.isArray(list) ? list : []
  const prefer = ['CF', 'F', 'TK', 'TN', 'GU']
  for (const code of prefer) {
    if (rows.some((row) => row.code === code)) return code
  }
  return rows.find((row) => trim(row.code).toUpperCase() !== 'CXL')?.code || rows[0]?.code || 'CF'
}

async function roomSetupOf(pool, hotelID, roomNo) {
  const room = trim(roomNo).toUpperCase()
  const result = await pool.request()
    .input('RoomNo', sql.VarChar(7), room)
    .input('HotelId', sql.Int, Number(hotelID))
    .query(`
      SELECT TOP 1
        LTRIM(RTRIM(RmNum)) AS RoomNo,
        LTRIM(RTRIM(RmType)) AS RoomType,
        LTRIM(RTRIM(ISNULL(RmFeature, ''))) AS RoomFeature,
        ISNULL(RateOnRoom, 0) AS RateOnRoom,
        LTRIM(RTRIM(ISNULL(RmStatus, ''))) AS RmStatus
      FROM RmSetupNum
      WHERE LTRIM(RTRIM(RmNum)) = @RoomNo AND HotelID = @HotelId
    `)
  const row = result.recordset?.[0]
  if (!row) throw fail(`ไม่พบห้อง ${room} ใน PMS`, 404)
  return {
    roomNo: trim(row.RoomNo),
    roomType: trim(row.RoomType),
    roomFeature: trim(row.RoomFeature),
    rate: money(row.RateOnRoom),
    status: trim(row.RmStatus).toUpperCase(),
  }
}

/**
 * ฟอร์มจองใหม่จากช่องว่างในปฏิทิน — ค่าเริ่มต้นจาก FRONT_OPTION + ห้องที่กด
 */
async function getNewBookingInfo({ dbName, hotelID, roomNo, arrival }) {
  const room = trim(roomNo)
  if (!room) throw fail('ไม่ได้ระบุห้อง')
  const pool = await connectDynamicDB(dbName)
  try {
    const sysDate = await getKioskSysDate({ dbName, hotelID }) || todayBangkok()
    const arrivalDay = /^\d{4}-\d{2}-\d{2}$/.test(trim(arrival)) ? trim(arrival) : sysDate
    if (arrivalDay < sysDate) throw fail(`วันเช็คอินต้องไม่ก่อนวันทำการของ PMS (${thaiDate(sysDate)})`)
    const setup = await roomSetupOf(pool, hotelID, room)
    const lookups = await checkInLookups(pool)
    const departure = addDays(arrivalDay, 1)
    const seed = {
      ArrivalYmd: arrivalDay,
      DeptYmd: departure,
      ArrivalHms: lookups.times.arrival || '14:00:00',
      DeptHms: lookups.times.departure || '12:00:00',
      RoomNo: setup.roomNo,
      RoomType: setup.roomType,
      RoomFeature: setup.roomFeature,
      ResvStatus: pickResvStatus(lookups.options.resvStatus),
      GstTitle: pickOption(lookups.options.title, 'Mr.'),
      GstFName: '',
      GstLName: '',
      Sex: 'male',
      Birthday: '',
      GstNation: pickOption(lookups.options.nation, lookups.defaults.nation),
      NationCardId: '',
      GstPassPortNo: '',
      TelNo: '',
      EMAIL: '',
      HomeAddress1: '',
      HomeAddress2: '',
      HomeAddress3: '',
      GstAgent: pickOption(lookups.options.agent, lookups.defaults.agent),
      VoucherNo: '',
      GstMarketCode: pickOption(lookups.options.market, lookups.defaults.market),
      GstBusSource: pickOption(lookups.options.source, lookups.defaults.source),
      GstType: pickOption(lookups.options.guestType, lookups.defaults.guestType),
      GstLevel: pickOption(lookups.options.guestLevel, lookups.defaults.guestLevel),
      GstAdult: 2,
      GstChildren: 0,
      RoomRateAmt: setup.rate,
      AbfAdult: 2,
      AbfAmt: 0,
      QtyAbfChild: 0,
      AbfChildAmt: 0,
      PaymentType: pickOption(lookups.options.paidBy, ''),
      DepositAmt: 0,
      DepositKeyAmt: 0,
      Reference: '',
      Chargeto: '',
      CreditLimit: 0,
      Memo1: '',
      Memo2: '',
    }
    return {
      roomNo: setup.roomNo,
      roomType: setup.roomType,
      roomFeature: setup.roomFeature,
      sysDate,
      arrival: arrivalDay,
      departure,
      rate: setup.rate,
      fields: EDIT_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        group: field.group,
        size: field.size || null,
        min: field.min != null ? field.min : null,
        required: Boolean(field.required),
        locked: false,
        options: field.type === 'select' ? lookups.options[field.key] || [] : null,
        value: fieldCurrent(seed, field),
      })),
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

/**
 * สร้างการจองใหม่จากปฏิทิน — Sp_GuestSequentUpdate + Sp_ReservationAppend(RecState=1)
 */
async function createReservation({ dbName, hotelID, userId, values }) {
  const input = values && typeof values === 'object' ? values : {}
  const user = trim(userId).slice(0, 20) || 'webadmin'
  const pool = await connectDynamicDB(dbName)
  try {
    const sysDate = await getKioskSysDate({ dbName, hotelID }) || todayBangkok()
    const lookups = await checkInLookups(pool)
    const patch = {}
    for (const field of EDIT_FIELDS) {
      let raw = field.key in input ? input[field.key] : undefined
      if (raw === undefined) {
        // ใช้ค่าเริ่มต้นจาก lookup เมื่อไม่ได้ส่งมา
        if (field.key === 'nation') raw = pickOption(lookups.options.nation, lookups.defaults.nation)
        else if (field.key === 'market') raw = pickOption(lookups.options.market, lookups.defaults.market)
        else if (field.key === 'source') raw = pickOption(lookups.options.source, lookups.defaults.source)
        else if (field.key === 'guestType') raw = pickOption(lookups.options.guestType, lookups.defaults.guestType)
        else if (field.key === 'guestLevel') raw = pickOption(lookups.options.guestLevel, lookups.defaults.guestLevel)
        else if (field.key === 'agent') raw = pickOption(lookups.options.agent, lookups.defaults.agent)
        else if (field.key === 'resvStatus') raw = pickResvStatus(lookups.options.resvStatus)
        else if (field.key === 'title') raw = pickOption(lookups.options.title, 'Mr.')
        else if (field.key === 'sex') raw = 'male'
        else if (field.key === 'adults') raw = 2
        else if (field.key === 'children') raw = 0
        else if (field.key === 'arrivalTime') raw = lookups.times.arrival || '14:00:00'
        else if (field.key === 'departureTime') raw = lookups.times.departure || '12:00:00'
        else if (field.type === 'money' || field.type === 'number') raw = 0
        else raw = ''
      }
      let next
      if (field.type === 'number') {
        next = Math.floor(Number(raw))
        if (!Number.isFinite(next) || next < (field.min ?? 0) || next > 99) {
          throw fail(`${field.label} ต้องอยู่ระหว่าง ${field.min ?? 0}–99`)
        }
      } else if (field.type === 'money') {
        next = money(raw)
        if (!(next >= (field.min ?? 0))) throw fail(`${field.label} ต้องไม่ติดลบ`)
      } else if (field.type === 'date') {
        next = trim(raw).slice(0, 10)
        if (field.required && !next) throw fail(`${field.label} ห้ามเว้นว่าง`)
        if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) throw fail(`${field.label} ไม่ถูกต้อง`)
      } else if (field.type === 'time') {
        next = normalizeTime(raw) || (field.key === 'arrivalTime' ? '14:00:00' : '12:00:00')
      } else {
        next = trim(raw)
        if (field.key === 'roomNo') next = next.toUpperCase()
        if (field.size && next.length > field.size) throw fail(`${field.label} ยาวเกิน ${field.size} ตัวอักษร`)
        if (!next && field.required) throw fail(`${field.label} ห้ามเว้นว่าง`)
        const choices = field.type === 'select' ? lookups.options[field.key] || [] : []
        if (next && choices.length && !choices.some((row) => row.code === next)) {
          throw fail(`${field.label} ไม่ถูกต้อง`)
        }
      }
      patch[field.column] = next
    }

    const arrival = patch.ArrivalYmd
    const departure = patch.DeptYmd
    const room = patch.RoomNo
    if (!arrival || !departure) throw fail('วันเช็คอินและวันเช็คเอาต์ต้องครบ')
    if (departure <= arrival) throw fail('วันเช็คเอาต์ต้องหลังวันเช็คอิน')
    if (arrival < sysDate) throw fail(`วันเช็คอินต้องไม่ก่อนวันทำการของ PMS (${thaiDate(sysDate)})`)
    if (nightsBetween(arrival, departure) > MAX_DAYS) {
      throw fail(`จองได้ไม่เกิน ${MAX_DAYS} คืน`)
    }

    const setup = await assertRoomVacant(pool, {
      hotelID,
      roomNo: room,
      arrival,
      departure,
      resvNo: 0,
    })
    if (!patch.RoomType) patch.RoomType = trim(setup.RoomType)
    if (!patch.RoomFeature) patch.RoomFeature = trim(setup.RoomFeature)

    const seq = await pool.request().execute('Sp_GuestSequentUpdate')
    const resvNo = Number(seq.returnValue) || Number(seq.recordset?.[0]?.ResvNo) || 0
    if (!resvNo) throw fail('สร้างเลขจองใหม่ไม่สำเร็จ')

    const firstName = trim(patch.GstFName)
    const lastName = trim(patch.GstLName)
    patch.ResvName = `${firstName} ${lastName}`.trim().slice(0, 48)
    if (!patch.AbfAdult && Number(patch.GstAdult) > 0) patch.AbfAdult = Number(patch.GstAdult)

    const guest = {
      ResvNo: resvNo,
      GstNo: 1,
      RoomCount: 1,
      HotelId: Number(hotelID),
      ResvDate: dateParam(sysDate),
      FolioPrintNo: 1,
    }
    await appendReservation(pool, guest, patch, { hotelID, user, recState: 1 })
    return {
      ok: true,
      resvNo: String(resvNo),
      roomNo: room,
      arrival,
      departure,
      guest: patch.ResvName || firstName,
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

/**
 * ย้ายการจองไปห้อง/วันใหม่แบบลากใน Booking Calendar ของ PMS (Sp_Transfer_Resv)
 * ต่างจาก PMS ตรงที่ตรวจห้องปลายทางที่เซิร์ฟเวอร์ และใช้วันเข้าพักจริงของการจอง
 * ย้ายได้เฉพาะการจองที่ยืนยันแล้วและยังไม่เช็คอิน (แถบสีเหลือง)
 */
async function moveReservation({ dbName, hotelID, comNo, resvNo, roomNo, newRoomNo, newArrival }) {
  const target = trim(newRoomNo)
  const arrivalNew = trim(newArrival)
  if (!target || target.length > 7) throw fail('ไม่ได้ระบุห้องปลายทาง')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrivalNew)) throw fail('วันเข้าพักใหม่ไม่ถูกต้อง')
  if (!comNo) throw fail('ยังไม่ได้ตั้งค่า ComNo ของ PMS')

  const pool = await connectDynamicDB(dbName)
  try {
    const context = await loadCheckInContext(pool, { dbName, hotelID, resvNo, roomNo })
    const { main, rows, reservationNo, arrival, departure, sysDate } = context
    const source = trim(main.RoomNo)
    if (rows.some((row) => isGroupResv(row.GroupResv))) throw fail('การจองแบบกรุ๊ป กรุณาย้ายจาก PMS')
    if (roomKey(source) !== roomKey(context.room)) throw fail(`การจองนี้ไม่ได้ผูกกับห้อง ${context.room}`)
    if (trim(main.ResvStatus).toUpperCase() === 'CXL') throw fail('การจองนี้ถูกยกเลิกแล้ว')
    if (rows.some(isCheckedIn)) throw fail('แขกเช็คอินแล้ว ย้ายจากปฏิทินไม่ได้')
    if (!arrival || !departure || departure <= arrival) throw fail('การจองนี้ยังไม่มีวันที่เข้าพักหรือวันที่ออก')

    const nights = nightsBetween(arrival, departure)
    if (nights > MAX_DAYS) throw fail(`การจองยาวเกิน ${MAX_DAYS} คืน กรุณาย้ายจาก PMS`)
    const sameRoom = roomKey(target) === roomKey(source)
    if (sameRoom && arrivalNew === arrival) throw fail('อยู่ตำแหน่งเดิม ไม่มีอะไรต้องย้าย')
    if (arrivalNew !== arrival && arrivalNew < sysDate) {
      throw fail(`ย้ายไปก่อนวันทำการของ PMS (${thaiDate(sysDate)}) ไม่ได้`)
    }
    const departureNew = addDays(arrivalNew, nights)
    const own = String(reservationNo)
    const today = todayBangkok()
    const rowOf = (list, roomNo) => list.find((row) => roomKey(row.RoomNo) === roomKey(roomNo))

    // 1) แถบต้นทางต้องเป็นการจองที่ยืนยันแล้ว (สีเหลือง) ของเลขจองนี้
    const seenFrom = arrival < today ? today : arrival
    if (seenFrom >= departure) throw fail('การจองนี้เลยวันเข้าพักไปแล้ว ย้ายไม่ได้')
    const before = await loadForecast(pool, { hotelID, comNo, bgn: seenFrom, end: seenFrom })
    const sourceCell = parseForecastCell(rowOf(before.rows, source)?.D1)
    if (!sourceCell || sourceCell.resvNo !== own) throw fail('ไม่พบการจองนี้ในห้องต้นทาง โหลดปฏิทินใหม่แล้วลองอีกครั้ง', 409)
    if (sourceCell.kind !== 'booked') throw fail('ย้ายได้เฉพาะการจองที่ยืนยันแล้วและยังไม่เช็คอิน')

    // 2) ห้องปลายทางต้องว่างทุกคืน ยกเว้นคืนที่เป็นของการจองนี้เองเมื่อเลื่อนวันในห้องเดิม
    const checkFrom = arrivalNew < today ? today : arrivalNew
    const checkTo = addDays(departureNew, -1)
    if (checkTo < checkFrom) throw fail('ช่วงวันใหม่อยู่ในอดีต ย้ายไม่ได้')
    const after = await loadForecast(pool, { hotelID, comNo, bgn: checkFrom, end: checkTo })
    const targetRow = rowOf(after.rows, target)
    if (!targetRow) throw fail(`ไม่พบห้อง ${target} ใน PMS`)
    for (let i = 0; i < after.totalDays; i += 1) {
      const cell = parseForecastCell(targetRow[`D${i + 1}`])
      if (!cell) continue
      const day = addDays(checkFrom, i)
      if (cell.resvNo === own) {
        if (sameRoom) continue
        throw fail(`ห้อง ${target} มีการจองเดียวกันนี้อยู่แล้ว`)
      }
      throw fail(`ห้อง ${target} ไม่ว่างวันที่ ${thaiDate(day)}${cell.guest ? ` (${cell.guest})` : ''}`)
    }

    const targetRoomNo = trim(targetRow.RoomNo)
    await pool.request()
      .input('HotelId', sql.Int, Number(hotelID))
      .input('RoomNo', sql.VarChar(7), source)
      .input('NewRoomNo', sql.VarChar(7), targetRoomNo)
      .input('ArrDate', sql.DateTime, dateParam(arrival))
      .input('ArrDateNew', sql.DateTime, dateParam(arrivalNew))
      .execute('dbo.Sp_Transfer_Resv')

    // 3) ยืนยันผลจากข้อมูลจริง เพราะ Sp_Transfer_Resv ไม่ส่งผลลัพธ์กลับ
    const reread = await pool.request()
      .input('ResvNo', sql.Int, reservationNo)
      .input('GstNo', sql.Int, Number(main.GstNo))
      .query(`
        SELECT TOP 1 LTRIM(RTRIM(RoomNo)) AS RoomNo,
          CONVERT(varchar(10), ArrivalDate, 23) AS ArrivalYmd,
          CONVERT(varchar(10), DeptDate, 23) AS DeptYmd
        FROM Reservation WHERE ResvNo = @ResvNo AND GstNo = @GstNo
      `)
    const fresh = reread.recordset?.[0]
    if (!fresh || roomKey(fresh.RoomNo) !== roomKey(targetRoomNo) || trim(fresh.ArrivalYmd) !== arrivalNew) {
      throw fail('PMS ไม่ได้ย้ายการจองนี้ กรุณาตรวจสอบและย้ายจาก PMS', 409)
    }
    return {
      ok: true,
      resvNo: own,
      fromRoom: source,
      roomNo: targetRoomNo,
      arrival: arrivalNew,
      departure: trim(fresh.DeptYmd) || departureNew,
    }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

module.exports = {
  loadPmsBookingCalendar,
  stopSaleRoom,
  releaseSaleRoom,
  getRoomFolio,
  postFolioEntry,
  voidFolioLine,
  checkoutRoomFolio,
  getCheckInInfo,
  checkInReservation,
  updateReservationInfo,
  getNewBookingInfo,
  createReservation,
  moveReservation,
  todayBangkok,
  addDays,
}
