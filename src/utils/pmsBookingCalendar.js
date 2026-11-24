/**
 * ปฏิทินจองจาก PMS
 * ตั้งแต่วันนี้ไปข้างหน้าใช้ Sp_Forecast_RoomNo แบบ Booking Calendar
 * ก่อนวันนี้สร้างจาก Front_Journal_CheckOut (folio history)
 */

const { sql, connectDynamicDB } = require('../db/mssql')
const { getKioskSysDate } = require('./kioskVacantRooms')

const MAX_DAYS = 31

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

module.exports = {
  loadPmsBookingCalendar,
  stopSaleRoom,
  releaseSaleRoom,
  getRoomFolio,
  postFolioEntry,
  checkoutRoomFolio,
  todayBangkok,
  addDays,
}
