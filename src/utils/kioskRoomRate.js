/**
 * kioskRoomRate.js
 * ดึงราคาห้องและ ABF จาก Kiosk ตาม logic ใน kioskController.js
 *
 * ตาราง: PeriodSetup → คอลัมน์ตามช่วงราคา, TrnCodeConfig → รหัสค่าห้อง/ABF
 *         Agent_Rate (AgNum='KIOSK') → Single_n / Twin_n / Triple_n / Fourth_n + Childn
 */

const { sql, connectDynamicDB } = require('../db/mssql')

function occupancyColumn(adults, period) {
  const p = Math.min(10, Math.max(1, Number(period) || 1))
  if (Number(adults) === 1) return `Single_${p}`
  if (Number(adults) === 2) return `Twin_${p}`
  if (Number(adults) === 3) return `Triple_${p}`
  return `Fourth_${p}`
}

function extraBedColumn(period) {
  const p = Math.min(10, Math.max(1, Number(period) || 1))
  return `Child${p}`
}

async function getPeriodNum(pool, arrivalDate) {
  const result = await pool.request()
    .input('ArrivalDate', sql.DateTime, new Date(arrivalDate))
    .query(`
      SELECT PeriodNum
      FROM PeriodSetup
      WHERE @ArrivalDate BETWEEN PeriodStr AND PeriodEnd
    `)
  if (!result.recordset[0]) return null
  const n = Number(result.recordset[0].PeriodNum)
  if (!Number.isFinite(n) || n < 1) return null
  return n > 10 ? 10 : n
}

async function getTrnCodes(pool) {
  const result = await pool.request().query(`SELECT RoomCharge, ABF FROM TrnCodeConfig`)
  return result.recordset[0] || null
}

/**
 * ราคาต่อคืนของประเภทห้องเดียว (เทียบ /api/kioskgetroomrateandabf)
 */
async function getKioskRoomRateAndAbf({ dbName, arrivalDate, gstAdult, gstChildren, rmTpCode }) {
  const pool = await connectDynamicDB(dbName)
  try {
    const period = await getPeriodNum(pool, arrivalDate)
    if (!period) return { roomCharge: 0, abf: 0, period: null }

    const codes = await getTrnCodes(pool)
    if (!codes) return { roomCharge: 0, abf: 0, period }

    const rateCol = occupancyColumn(gstAdult, period)
    const extraCol = extraBedColumn(period)
    const hasChild = Number(gstChildren) === 1

    const result = await pool.request()
      .input('RmTpCode', sql.VarChar, String(rmTpCode))
      .input('GstAgent', sql.VarChar, 'KIOSK')
      .input('RoomCharge', sql.VarChar, codes.RoomCharge)
      .input('ABF', sql.VarChar, codes.ABF)
      .query(`
        SELECT TransCode, [${rateCol}] AS RateAmount, [${extraCol}] AS ExtraBedAmount
        FROM Agent_Rate
        WHERE RoomType = @RmTpCode
          AND AgNum = @GstAgent
          AND (TransCode = @RoomCharge OR TransCode = @ABF)
      `)

    let roomCharge = 0
    let abf = 0
    for (const row of result.recordset || []) {
      const base = Number(row.RateAmount) || 0
      const extra = hasChild ? Number(row.ExtraBedAmount) || 0 : 0
      const amount = base + extra
      if (String(row.TransCode) === String(codes.RoomCharge)) roomCharge = amount
      else if (String(row.TransCode) === String(codes.ABF)) abf = amount
    }
    return { roomCharge, abf, period }
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

/**
 * ราคาค่าห้อง (ไม่รวม ABF) ของหลายประเภท — ใช้โชว์บนการ์ดค้นหา
 * เทียบส่วน rate ของ KioskAvailableRoomTypes
 */
async function getKioskTypeRates({ dbName, arrivalDate, gstAdult, gstChildren, rmTpCodes }) {
  const codes = [...new Set((rmTpCodes || []).map((c) => String(c || '').trim()).filter(Boolean))]
  const map = {}
  if (!codes.length) return map

  const pool = await connectDynamicDB(dbName)
  try {
    const period = await getPeriodNum(pool, arrivalDate)
    if (!period) return map

    const trn = await getTrnCodes(pool)
    if (!trn) return map

    const rateCol = occupancyColumn(gstAdult, period)
    const extraCol = extraBedColumn(period)
    const hasChild = Number(gstChildren) === 1

    const req = pool.request()
      .input('GstAgent', sql.VarChar, 'KIOSK')
      .input('RoomChargeCode', sql.VarChar, trn.RoomCharge)
      .input('ABFCode', sql.VarChar, trn.ABF)

    const placeholders = codes.map((code, i) => {
      const name = `RmTp${i}`
      req.input(name, sql.VarChar, code)
      return `@${name}`
    })

    const result = await req.query(`
      SELECT RoomType, TransCode, [${rateCol}] AS RateAmount, [${extraCol}] AS ExtraBedAmount
      FROM Agent_Rate
      WHERE AgNum = @GstAgent
        AND RoomType IN (${placeholders.join(', ')})
        AND (TransCode = @RoomChargeCode OR TransCode = @ABFCode)
    `)

    for (const code of codes) map[code] = { roomCharge: 0, abf: 0 }

    for (const row of result.recordset || []) {
      const type = String(row.RoomType || '').trim()
      if (!map[type]) map[type] = { roomCharge: 0, abf: 0 }
      const base = Number(row.RateAmount) || 0
      const extra = hasChild ? Number(row.ExtraBedAmount) || 0 : 0
      const amount = base + extra
      if (String(row.TransCode) === String(trn.RoomCharge)) map[type].roomCharge = amount
      else if (String(row.TransCode) === String(trn.ABF)) map[type].abf = amount
    }
    return map
  } finally {
    try { await pool.close() } catch { /* ignore */ }
  }
}

module.exports = { getKioskRoomRateAndAbf, getKioskTypeRates }
