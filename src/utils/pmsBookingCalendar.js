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

async function folioLines(pool, roomNo, folioNo) {
  try {
    const result = await pool.request()
      .input('roomno', sql.VarChar(7), roomNo)
      .input('foliono', sql.Int, folioNo)
      .query(`
        SELECT TOP 40
          CONVERT(varchar(16), F.DateTime, 120) AS postedAt,
          LTRIM(RTRIM(F.Trans_Code)) AS code,
          LTRIM(RTRIM(ISNULL(T.TrnName, F.Trans_Code))) AS name,
          F.Qty AS qty,
          F.Amount AS amount,
          F.Charge_Type AS chargeType,
          LTRIM(RTRIM(ISNULL(F.Remark, ''))) AS remark
        FROM dbo.Front_Journal F
        LEFT JOIN dbo.TrnCode T ON LTRIM(RTRIM(F.Trans_Code)) = LTRIM(RTRIM(T.TrnCode))
        WHERE LTRIM(RTRIM(F.ChargeRoomNo)) = @roomno
          AND F.FolioNo = @foliono
          AND ISNULL(F.Adjust, 0) = 0
          AND ISNULL(F.VOID, 0) = 0
        ORDER BY F.DateTime DESC
      `)
    return (result.recordset || []).map((row) => ({
      postedAt: row.postedAt,
      code: trim(row.code),
      name: trim(row.name),
      qty: Number(row.qty) || 0,
      amount: money(row.chargeType === -1 ? -Math.abs(row.amount) : row.amount),
      remark: trim(row.remark),
    }))
  } catch {
    return []
  }
}

async function folioCatalog(pool) {
  const [items, payments, companies] = await Promise.all([
    pool.request().query(`
      SELECT LTRIM(RTRIM(TrnCode)) AS code, LTRIM(RTRIM(TrnName)) AS name, TrnPrice1 AS price
      FROM dbo.TrnCode
      WHERE TrnGroupCode = '1' AND TrnCodeRecordStatus = 'Y' AND ISNULL(TrnCredit, 0) = 0
      ORDER BY TrnCode
    `),
    pool.request().query(`
      SELECT LTRIM(RTRIM(TrnCode)) AS code, LTRIM(RTRIM(TrnName)) AS name
      FROM dbo.TrnCode
      WHERE TrnCodeRecordStatus = 'Y' AND (TrnGrp = 9 OR ISNULL(TrnCredit, 0) = 1)
      ORDER BY TrnCode
    `),
    pool.request().query(`
      SELECT LTRIM(RTRIM(AgNum)) AS code, LTRIM(RTRIM(AgName)) AS name
      FROM dbo.Agent
      WHERE Status = 'A' AND Contact = 'Y'
      ORDER BY AgName
    `).catch(() => ({ recordset: [] })),
  ])
  const mapCode = (row) => ({ code: trim(row.code), name: trim(row.name), price: money(row.price) })
  return {
    charges: (items.recordset || []).map(mapCode).filter((row) => row.code),
    payments: (payments.recordset || []).map(mapCode).filter((row) => row.code),
    companies: (companies.recordset || []).map(mapCode).filter((row) => row.code),
  }
}

async function getRoomFolio({ dbName, roomNo }) {
  const room = trim(roomNo)
  if (!room) throw fail('ไม่ได้ระบุห้อง')
  const pool = await connectDynamicDB(dbName)
  try {
    const status = await pool.request()
      .input('RmNum', sql.VarChar(7), room)
      .query(`SELECT LTRIM(RTRIM(RmStatus)) AS RmStatus, ResvNo FROM dbo.RmSetupNum WHERE LTRIM(RTRIM(RmNum)) = @RmNum`)
    const row = status.recordset?.[0]
    if (!row) throw fail('ไม่พบห้องใน PMS', 404)
    const inHouse = String(row.RmStatus || '').toUpperCase() === 'CI'
    if (!inHouse) throw fail('ห้องนี้ไม่ได้เช็คอิน จึงเช็คเอาต์หรือลงรายการไม่ได้')
    const folioNo = await folioNoOf(pool, room)
    if (!folioNo) throw fail('ไม่พบโฟลิโอของห้องนี้')
    const [balance, lines, catalog] = await Promise.all([
      folioBalance(pool, room, folioNo),
      folioLines(pool, room, folioNo),
      folioCatalog(pool),
    ])
    return {
      roomNo: room,
      status: row.RmStatus,
      resvNo: row.ResvNo != null ? String(row.ResvNo) : '',
      folioNo,
      balance,
      lines,
      ...catalog,
      canCheckout: Math.abs(balance.amount) < 0.01,
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
    return getRoomFolio({ dbName, roomNo: room })
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
    if (Math.abs(balance.amount) >= 0.01) {
      throw fail(`ยังมียอดค้าง ฿${balance.amount.toLocaleString()} ลงรายการชำระให้ครบก่อนเช็คเอาต์`)
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
  const [nation, market, source, guestType, guestLevel, paidBy] = await Promise.all([
    lookupList(pool, 'SELECT NationalityCode AS code, NationalityName AS name FROM Nationality ORDER BY NationalityName'),
    lookupList(pool, 'SELECT MarketCode AS code, MarketName AS name FROM MarketCode ORDER BY MarketName'),
    lookupList(pool, 'SELECT BusinessCode AS code, BusinessName AS name FROM BusinessSource ORDER BY BusinessName'),
    lookupList(pool, 'SELECT GstType AS code, GstTypeName AS name FROM GstType ORDER BY GstTypeName'),
    lookupList(pool, 'SELECT GstStatusCode AS code, GstStatusName AS name FROM GstLevel ORDER BY GstStatusName'),
    lookupList(pool, `SELECT TrnCode AS code, TrnName AS name FROM TrnCode WHERE TrnDeposit = 'Y' ORDER BY TrnCode`),
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
    options: { nation, market, source, guestType, guestLevel },
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
      canCheckIn: !context.block,
      blockReason: context.block,
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

module.exports = {
  loadPmsBookingCalendar,
  stopSaleRoom,
  releaseSaleRoom,
  getRoomFolio,
  postFolioEntry,
  checkoutRoomFolio,
  getCheckInInfo,
  checkInReservation,
  todayBangkok,
  addDays,
}
