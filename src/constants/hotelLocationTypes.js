/** ค่าเริ่มต้นลักษณะที่ตั้ง — แก้รายการจริงต่อสาขาที่ hotel_catalog_options */
const LOCATION_TYPE_OPTIONS = [
  { value: 'near_attraction', label: 'ติดสถานที่ท่องเที่ยว' },
  { value: 'near_beach', label: 'ติดหาด' },
  { value: 'near_sea', label: 'ติดทะเล' },
  { value: 'in_city', label: 'ในเมือง' },
  { value: 'out_of_city', label: 'นอกเมือง' },
]

const LOCATION_TYPE_VALUES = new Set(LOCATION_TYPE_OPTIONS.map((o) => o.value))

/** เก็บค่าเป็น slug อิสระ (ตรวจกับรายการสาขาตอนบันทึก) */
function normalizeLocationType(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return raw.slice(0, 64)
}

function locationTypeLabel(value, options = LOCATION_TYPE_OPTIONS) {
  const key = String(value || '').trim()
  if (!key) return ''
  return (options || []).find((o) => o.value === key)?.label || ''
}

module.exports = {
  LOCATION_TYPE_OPTIONS,
  LOCATION_TYPE_VALUES,
  normalizeLocationType,
  locationTypeLabel,
}
