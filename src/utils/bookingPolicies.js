const { getHotelSettings } = require('./hotelSettings')

const LEGACY_CANCELLATION = {
  flexible: 'ยกเลิกได้ฟรีถึง 24 ชั่วโมงก่อนวันเช็คอิน',
  moderate: 'ยกเลิกได้ฟรีถึง 3 วันก่อนวันเช็คอิน หากยกเลิกช้ากว่านั้นอาจมีค่าธรรมเนียม',
  strict: 'ไม่สามารถยกเลิกหรือขอคืนเงินได้',
}

function normalizeCancellationPolicy(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return LEGACY_CANCELLATION[text] || text
}

function parseNonSmoking(value) {
  const s = String(value || '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes'].includes(s)
}

function parseNonSmokingFine(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

async function getHotelBookingPolicies(pool, hotelId) {
  const map = await getHotelSettings(pool, hotelId, [
    'cancellation_policy',
    'non_smoking',
    'non_smoking_fine',
  ])
  return {
    cancellation_policy: normalizeCancellationPolicy(map.cancellation_policy),
    non_smoking: parseNonSmoking(map.non_smoking),
    non_smoking_fine: parseNonSmokingFine(map.non_smoking_fine),
  }
}

function applyBookingPolicies(target, policies) {
  if (!target || !policies) return target
  target.cancellation_policy = normalizeCancellationPolicy(policies.cancellation_policy)
  target.non_smoking = parseNonSmoking(policies.non_smoking)
  target.non_smoking_fine = parseNonSmokingFine(policies.non_smoking_fine)
  return target
}

module.exports = {
  LEGACY_CANCELLATION,
  normalizeCancellationPolicy,
  parseNonSmoking,
  parseNonSmokingFine,
  getHotelBookingPolicies,
  applyBookingPolicies,
}
