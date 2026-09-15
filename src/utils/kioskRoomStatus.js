/**
 * kioskRoomStatus.js
 * ดึงสถานะห้องพักแบบ live จากตาราง RmSetupNum (MSSQL / Kiosk)
 * + ห้องเข้าวันนี้: Reservation.ArrivalDate (เทียบวันแบบ Asia/Bangkok) → RoomNo เทียบ RmNum
 *
 * หมายเหตุ: ตอนดันจองใช้ DateTime ของ midnight Bangkok (+07) ซึ่งใน SQL มักเก็บเป็น
 * วันก่อนหน้า 17:00 (เช่น 10 ก.ย. → 2026-09-09 17:00:00) จึงต้องบวก 7 ชม. ก่อนเทียบวัน
 */

const { sql, connectDynamicDB } = require('../db/mssql')

function trim(v) {
  return String(v ?? '').trim()
}

function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
}

function classifyHk(hk, rm) {
  const status = (hk || rm || '').toUpperCase()
  return {
    inHouse:     status === 'OC' || status === 'OD',
    clean:       status === 'VC' || status === 'OC',
    dirty:       status === 'VD' || status === 'OD',
    outOfOrder:  status === 'OOO',
  }
}

function normRoomNo(value) {
  return trim(value).toUpperCase()
}

/**
 * @param {object} opts
 * @param {string}        opts.dbName
 * @param {string|number} opts.hotelID
 * @returns {Promise<{ rooms: object[], counts: object }>}
 */
async function getKioskRoomStatus({ dbName, hotelID }) {
  const pool = await connectDynamicDB(dbName)
  try {
    const today = todayBangkok()
    const hotelId = Number(hotelID)

    const roomsResult = await pool.request()
      .input('HotelId', sql.Int, hotelId)
      .query(`
        SELECT
          LTRIM(RTRIM(RmNum))      AS room_number,
          RmFloor                  AS floor,
          LTRIM(RTRIM(RmType))     AS room_type,
          LTRIM(RTRIM(RmStatus))   AS rm_status,
          LTRIM(RTRIM(RmHKStatus)) AS hk_status,
          LTRIM(RTRIM(RmGstName1)) AS guest_name,
          LTRIM(RTRIM(GstAgent))   AS agent,
          RmStatusStrDate          AS date_from,
          RmStatusEndDate          AS date_to
        FROM RmSetupNum
        WHERE HotelID = @HotelId
          AND ISNULL(RmFloor, 0) > 0
        ORDER BY RmFloor, RmNum
      `)

    // จองเก่าจากเว็บเคยเก็บ ArrivalDate เป็น UTC ของเที่ยงคืนไทย → วันก่อน 17:00
    // จองใหม่ + จาก PMS คีออสก์ = วันนั้น 00:00:00 — DATEADD(+7) ครอบคลุมทั้งสองแบบ
    const arrivalResult = await pool.request()
      .input('Today', sql.VarChar(10), today)
      .query(`
        SELECT DISTINCT
          LTRIM(RTRIM(RoomNo)) AS room_no
        FROM Reservation
        WHERE RoomNo IS NOT NULL
          AND LTRIM(RTRIM(RoomNo)) <> ''
          AND CONVERT(date, DATEADD(HOUR, 7, ArrivalDate)) = CONVERT(date, @Today)
          AND ISNULL(NULLIF(LTRIM(RTRIM(ResvStatus)), ''), '') <> 'CXL'
          AND ISNULL(NULLIF(LTRIM(RTRIM(Status)), ''), '') <> 'CO'
      `)

    const arrivalRoomNos = new Set(
      (arrivalResult.recordset || [])
        .map((row) => normRoomNo(row.room_no))
        .filter(Boolean)
    )

    const rooms = (roomsResult.recordset || []).map((row) => {
      const room_number = trim(row.room_number)
      const rm_status = trim(row.rm_status)
      const hk_status = trim(row.hk_status)
      const arrival_today = arrivalRoomNos.has(normRoomNo(room_number))
      return {
        room_number,
        floor:       row.floor ?? null,
        room_type:   trim(row.room_type),
        rm_status,
        hk_status,
        guest_name:  trim(row.guest_name),
        agent:       trim(row.agent),
        date_from:   row.date_from || null,
        date_to:     row.date_to || null,
        arrival_date: arrival_today ? today : null,
        arrival_today,
      }
    }).filter((r) => r.room_number)

    const counts = {
      all: rooms.length,
      inHouse: 0,
      clean: 0,
      dirty: 0,
      outOfOrder: 0,
      arrivalToday: 0,
    }
    for (const r of rooms) {
      const c = classifyHk(r.hk_status, r.rm_status)
      if (c.inHouse)    counts.inHouse++
      if (c.clean)      counts.clean++
      if (c.dirty)      counts.dirty++
      if (c.outOfOrder) counts.outOfOrder++
      if (r.arrival_today) counts.arrivalToday++
    }

    return { rooms, counts }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

module.exports = { getKioskRoomStatus }
