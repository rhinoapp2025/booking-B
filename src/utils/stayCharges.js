function parsePercent(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(100, n)
}

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

function sanitizePercentSetting(value) {
  const n = parsePercent(value, 0)
  if (!Number.isFinite(Number(value)) || String(value).trim() === '') return '0'
  return String(n)
}

/**
 * Service charge คิดจากยอดห้อง+อาหารเช้า แล้ว VAT คิดจากยอดรวมค่าบริการ
 * ใช้เฉพาะโหมดเก็บเต็มจำนวน — มัดจำไม่บวก SC/VAT
 */
function applyStayCharges(subtotal, { collectFull, serviceChargePercent, vatPercent } = {}) {
  const base = roundMoney(subtotal)
  if (!collectFull) {
    return {
      subtotal: base,
      service_charge_percent: 0,
      vat_percent: 0,
      service_charge: 0,
      vat: 0,
      total: base,
    }
  }
  const scPct = parsePercent(serviceChargePercent)
  const vatPct = parsePercent(vatPercent)
  const service_charge = roundMoney(base * scPct / 100)
  const vat = roundMoney((base + service_charge) * vatPct / 100)
  return {
    subtotal: base,
    service_charge_percent: scPct,
    vat_percent: vatPct,
    service_charge,
    vat,
    total: roundMoney(base + service_charge + vat),
  }
}

module.exports = {
  parsePercent,
  roundMoney,
  sanitizePercentSetting,
  applyStayCharges,
}
