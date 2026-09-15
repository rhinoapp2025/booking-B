/**
 * kioskVacantRooms.js
 * ดึงรายการห้องว่างจาก Kiosk (MSSQL) สำหรับใช้กรองห้องพักในระบบจอง
 *
 * startDate = วันเช็คอิน, endDate = วันเช็คเอาต์ (ไม่นับคืนวันออก)
 * เข้า 7 ออก 8 → ตรวจว่างแค่ D1 (คืนวันที่ 7)
 *
 * filterVC: คีออสก์ walk-in วันเดียวกันกรอง VC/VC — เว็บจองไม่ใช้
 */

const { sql, connectDynamicDB } = require('../db/mssql')

function trim(v) {
  return String(v ?? '').trim()
}

/**
 * @returns {Promise<Array<{ room_number: string, room_type: string, floor: number|null, rate: number }>>}
 */
async function getKioskVacantRooms({ dbName, hotelID, comNo, startDate, endDate, filterVC }) {
  const start = new Date(startDate)
  const end   = new Date(endDate)

  const diffMs = end.getTime() - start.getTime()
  // วันสิ้นสุด = เช็คเอาต์ ไม่นับคืนนั้น (เข้า 7 ออก 8 = 1 คืน)
  const nights = Math.max(1, Math.round(diffMs / 86400000))
  if (nights > 100) throw new Error('Date range cannot exceed 100 days')
  const spEnd = diffMs <= 0 ? new Date(start.getTime() + 86400000) : end

  const pool = await connectDynamicDB(dbName)
  try {
    await pool.request()
      .input('Bgn_Date', sql.DateTime, start)
      .input('End_Date', sql.DateTime, spEnd)
      .input('CompNo',   sql.SmallInt, Number(comNo))
      .input('HotelId',  sql.Int,      Number(hotelID))
      .execute('Sp_Room_Vacant')

    const emptyDays = Array.from({ length: nights }, (_, i) =>
      `ISNULL(LTRIM(RTRIM(rv.D${i + 1})), '') = ''`
    ).join(' AND ')

    const vcExtra = filterVC
      ? `AND rsn.RmStatus = 'VC' AND rsn.RmHKStatus = 'VC'`
      : ''

    const result = await pool.request()
      .input('HotelIdFilter', sql.Int, Number(hotelID))
      .query(`
        SELECT
          LTRIM(RTRIM(rv.RoomNo))   AS room_number,
          LTRIM(RTRIM(rv.RoomType)) AS room_type,
          rsn.RmFloor               AS floor,
          rsn.RateOnRoom            AS rate
        FROM Room_Vacant rv
        INNER JOIN RmSetupNum rsn
          ON  LTRIM(RTRIM(rsn.RmNum)) = LTRIM(RTRIM(rv.RoomNo))
          AND rsn.HotelID = @HotelIdFilter
          ${vcExtra}
        WHERE ${emptyDays}
          AND ISNULL(rsn.RmFloor, 0) > 0
      `)

    const rooms = []
    const seen = new Set()
    for (const r of result.recordset || []) {
      const room_number = trim(r.room_number).toUpperCase()
      if (!room_number || seen.has(room_number)) continue
      seen.add(room_number)
      rooms.push({
        room_number,
        room_type: trim(r.room_type) || 'Standard',
        floor:     r.floor != null ? Number(r.floor) : null,
        rate:      Number(r.rate) || 0,
      })
    }
    return rooms
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

async function getKioskVacantRoomNumbers(opts) {
  const rooms = await getKioskVacantRooms(opts)
  return new Set(rooms.map((r) => r.room_number))
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + days))
  return dt.toISOString().slice(0, 10)
}

function ymdOf(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  try {
    return value.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  } catch {
    return ''
  }
}

function stayYmds(checkIn, checkOut) {
  const from = ymdOf(checkIn)
  const to = ymdOf(checkOut)
  const out = []
  if (!from || !to || to <= from) return out
  let d = from
  while (d < to) {
    out.push(d)
    d = addDaysYmd(d, 1)
  }
  return out
}

/**
 * นับห้องว่างต่อประเภทต่อวัน จาก sp_HotelCurrentRooms (เหมือนหน้า New Booking ของ PMS)
 * ไม่ใช้ Sp_Room_Vacant — ค่านั้นสูงกว่าตัวเลขขายจริงที่ PMS แสดง
 * @returns {Promise<Record<string, Record<string, number>>>} typeName -> ymd -> count
 */
async function getKioskVacantByTypeDate({ dbName, hotelID, comNo, startDate, endDate }) {
  const startYmd = ymdOf(startDate)
  const endYmd = ymdOf(endDate)
  if (!startYmd || !endYmd || endYmd < startYmd) return {}

  const merged = {}
  let cursor = startYmd
  const CHUNK = 30
  while (cursor <= endYmd) {
    const chunkEnd = addDaysYmd(cursor, CHUNK - 1)
    const until = chunkEnd < endYmd ? chunkEnd : endYmd
    const part = await fetchCurrentRoomsTypeDateChunk({
      dbName, hotelID, comNo, startYmd: cursor, endYmd: until,
    })
    for (const [typeName, days] of Object.entries(part)) {
      if (!merged[typeName]) merged[typeName] = {}
      Object.assign(merged[typeName], days)
    }
    cursor = addDaysYmd(until, 1)
  }
  return merged
}

async function fetchCurrentRoomsTypeDateChunk({ dbName, hotelID, comNo, startYmd, endYmd }) {
  const start = new Date(`${startYmd}T00:00:00+07:00`)
  // SP ถือ RmDateEnd เป็นวันเช็คเอาต์ (ไม่นับคืนนั้น) จึงส่งวันถัดจากคืนสุดท้ายที่ต้องการ
  const end = new Date(`${addDaysYmd(endYmd, 1)}T00:00:00+07:00`)
  const pool = await connectDynamicDB(dbName)
  try {
    await pool.request()
      .input('RmDateBgn', sql.DateTime, start)
      .input('RmDateEnd', sql.DateTime, end)
      .input('HotelID', sql.Int, Number(hotelID))
      .input('ComNo', sql.SmallInt, Number(comNo))
      .execute('sp_HotelCurrentRooms')

    const rmtypeResult = await pool.request().query(`
      SELECT RmTypeNo, RmTpCode FROM dbo.rmtype
    `)
    const rmtypeMap = {}
    const rmtypeNos = []
    for (const rt of rmtypeResult.recordset || []) {
      const no = Number(rt.RmTypeNo)
      if (!Number.isInteger(no) || no < 1 || no > 15) continue
      const code = trim(rt.RmTpCode)
      if (!code) continue
      rmtypeMap[no] = code
      rmtypeNos.push(no)
    }

    const result = await pool.request().query(`
      SELECT
        CONVERT(varchar(10), Bdate, 23) AS bdate,
        Vacant,
        RmType1, RmType2, RmType3, RmType4, RmType5,
        RmType6, RmType7, RmType8, RmType9, RmType10,
        RmType11, RmType12, RmType13, RmType14, RmType15
      FROM dbo.Hotel_CurrentRooms
      ORDER BY Bdate
    `)

    const map = {}
    for (const row of result.recordset || []) {
      const ymd = ymdOf(row.bdate ?? row.Bdate)
      if (!ymd || ymd < startYmd || ymd > endYmd) continue
      for (const typeNo of rmtypeNos) {
        const typeName = rmtypeMap[typeNo]
        if (!typeName) continue
        const n = Number(row[`RmType${typeNo}`])
        if (!map[typeName]) map[typeName] = {}
        map[typeName][ymd] = Number.isFinite(n) ? n : 0
      }
    }
    return map
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

/**
 * จำนวนที่เปิดขายต่อประเภทสำหรับทั้งช่วงพัก = ค่าน้อยสุดของ Hotel_CurrentRooms ทุกคืน (ไม่รวมวันเช็คเอาต์)
 * @returns {Promise<Record<string, number>>} typeName -> count
 */
async function getKioskStaySellableByType({ dbName, hotelID, comNo, checkIn, checkOut }) {
  const nights = stayYmds(checkIn, checkOut)
  if (!nights.length) return {}
  const byDate = await getKioskVacantByTypeDate({
    dbName,
    hotelID,
    comNo,
    startDate: nights[0],
    endDate: nights[nights.length - 1],
  })
  const out = {}
  for (const [typeName, days] of Object.entries(byDate)) {
    let min = Infinity
    for (const d of nights) {
      const n = Number(days?.[d])
      if (!Number.isFinite(n)) {
        min = 0
        break
      }
      min = Math.min(min, n)
    }
    out[typeName] = Number.isFinite(min) ? min : 0
  }
  return out
}

/**
 * วันที่ระบบโรงแรมจาก CustInfo.SysDate (เทียบ kioskController getKioskDefaultOptions)
 * @returns {Promise<string|null>} YYYY-MM-DD
 */
async function getKioskSysDate({ dbName, hotelID }) {
  const pool = await connectDynamicDB(dbName)
  try {
    const result = await pool.request()
      .input('hotelID', sql.Int, Number(hotelID))
      .query(`
        SELECT TOP (1) CONVERT(varchar(10), ci.SysDate, 23) AS sys_date
        FROM FRONT_OPTION fo
        LEFT JOIN CustInfo ci ON ci.HotelID = fo.HotelID
        WHERE fo.HotelID = @hotelID
      `)
    const raw = result.recordset?.[0]?.sys_date
    return raw ? String(raw).slice(0, 10) : null
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

/**
 * สร้าง room_types / rooms ใน PostgreSQL ให้ตรงกับห้องจาก Kiosk
 * เพื่อให้จองได้จริง (ต้องมี room_id)
 */
async function ensureKioskRoomsInPg(pg, hotelId, kioskRooms) {
  const typeCache = new Map()
  const synced = []

  for (const kr of kioskRooms) {
    const typeName = kr.room_type || 'Standard'
    if (!typeCache.has(typeName)) {
      const existing = await pg.query(
        `SELECT id, name, description, price_per_night, max_adults, max_children,
                bed_type, size_sqm, images, amenities, view_type
         FROM room_types
         WHERE hotel_id = $1 AND name = $2`,
        [hotelId, typeName]
      )
      if (existing.rows[0]) {
        typeCache.set(typeName, existing.rows[0])
      } else {
        const price = kr.rate > 0 ? kr.rate : 0
        const inserted = await pg.query(
          `INSERT INTO room_types (hotel_id, name, price_per_night, max_adults, max_children)
           VALUES ($1, $2, $3, 2, 1)
           ON CONFLICT (hotel_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, name, description, price_per_night, max_adults, max_children,
                     bed_type, size_sqm, images, amenities, view_type`,
          [hotelId, typeName, price]
        )
        typeCache.set(typeName, inserted.rows[0])
      }
    }

    const rt = typeCache.get(typeName)
    const room = await pg.query(
      `INSERT INTO rooms (hotel_id, room_type_id, room_number, floor, status)
       VALUES ($1, $2, $3, $4, 'available')
       ON CONFLICT (hotel_id, room_number) DO UPDATE
         SET room_type_id = EXCLUDED.room_type_id,
             floor = COALESCE(EXCLUDED.floor, rooms.floor),
             status = 'available'
       RETURNING id, room_number, floor`,
      [hotelId, rt.id, kr.room_number, kr.floor]
    )
    synced.push({
      room_id:         room.rows[0].id,
      room_number:     room.rows[0].room_number,
      floor:           room.rows[0].floor,
      room_type_id:    rt.id,
      room_type_name:  rt.name,
      description:     rt.description,
      price_per_night: rt.price_per_night,
      max_adults:      rt.max_adults,
      max_children:    rt.max_children,
      bed_type:        rt.bed_type,
      size_sqm:        rt.size_sqm,
      images:          rt.images,
      amenities:       rt.amenities,
      view_type:       rt.view_type,
    })
  }

  return synced
}

/**
 * ประเภทห้องจาก master PMS (ตาราง RmType) — ใช้รหัส RmTpCode เป็นชื่อใน PG
 */
async function listPmsRmTypes({ dbName, hotelID }) {
  const pool = await connectDynamicDB(dbName)
  try {
    const hotelId = Number(hotelID)
    const result = await pool.request()
      .input('HotelId', sql.Int, hotelId)
      .query(`
        SELECT
          LTRIM(RTRIM(RmTpCode)) AS code,
          LTRIM(RTRIM(RmTpName)) AS name,
          RmTypeNo AS type_no,
          MaxPerson AS max_person
        FROM RmType
        WHERE HotelID = @HotelId
          AND LTRIM(RTRIM(ISNULL(RmTpCode, ''))) <> ''
        ORDER BY RmTpCode
      `)
    return (result.recordset || [])
      .map((row) => {
        const code = String(row.code || '').trim()
        const name = String(row.name || '').trim()
        const maxPerson = Number(row.max_person)
        return {
          code,
          name,
          type_no: row.type_no != null ? Number(row.type_no) : null,
          max_adults: Number.isFinite(maxPerson) && maxPerson > 0 ? maxPerson : 2,
          label: name ? `${code} — ${name}` : code,
        }
      })
      .filter((r) => r.code)
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

function pmsTypeCodeKey(name) {
  return String(name || '').trim().toUpperCase()
}

/**
 * ซิงก์ RmType เข้า PG แล้วคืน Map รหัส (ตัวพิมพ์ใหญ่) → รายการ PMS
 * ประเภทที่สร้างตอนปิด PMS จะไม่ได้อยู่ใน Map นี้
 */
async function syncPmsRoomTypesToPg(pg, hotelId, { dbName, hotelID }) {
  const pmsTypes = await listPmsRmTypes({ dbName, hotelID })
  const pmsByCode = new Map()
  for (const rt of pmsTypes) {
    const key = pmsTypeCodeKey(rt.code)
    if (!key) continue
    pmsByCode.set(key, rt)
    await pg.query(
      `INSERT INTO room_types (hotel_id, name, description, price_per_night, max_adults, max_children)
       VALUES ($1, $2, $3, 0, $4, 1)
       ON CONFLICT (hotel_id, name) DO NOTHING`,
      [hotelId, rt.code, rt.name || null, rt.max_adults]
    )
  }
  return pmsByCode
}

function isPmsRoomTypeName(pmsByCode, name) {
  return Boolean(pmsByCode && pmsByCode.has(pmsTypeCodeKey(name)))
}

module.exports = {
  getKioskVacantRooms,
  getKioskVacantRoomNumbers,
  getKioskVacantByTypeDate,
  getKioskStaySellableByType,
  getKioskSysDate,
  ensureKioskRoomsInPg,
  listPmsRmTypes,
  syncPmsRoomTypesToPg,
  pmsTypeCodeKey,
  isPmsRoomTypeName,
}
