const {
  LOCATION_TYPE_OPTIONS,
} = require('../constants/hotelLocationTypes')

const DEFAULT_VIEW_TYPE_OPTIONS = [
  { value: 'garden', label: 'วิวสวน' },
  { value: 'sea', label: 'วิวทะเล' },
  { value: 'mountain', label: 'วิวภูเขา' },
  { value: 'river', label: 'วิวแม่น้ำ' },
]

const KINDS = new Set(['location_type', 'view_type'])

function defaultOptions(kind) {
  if (kind === 'view_type') return DEFAULT_VIEW_TYPE_OPTIONS.map((o) => ({ ...o }))
  return LOCATION_TYPE_OPTIONS.map((o) => ({ ...o }))
}

function slugifyValue(rawLabel, fallbackPrefix) {
  const label = String(rawLabel || '').trim()
  const latin = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  if (latin) return latin
  return `${fallbackPrefix}_${Date.now().toString(36)}`
}

function normalizeOptionValue(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  const cleaned = raw.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return cleaned
}

function normalizeOptionLabel(label) {
  return String(label ?? '').trim().slice(0, 80)
}

function sanitizeOptionsList(kind, rows) {
  const prefix = kind === 'view_type' ? 'view' : 'loc'
  const seen = new Set()
  const out = []
  for (const row of rows || []) {
    let value = normalizeOptionValue(row?.value)
    const label = normalizeOptionLabel(row?.label)
    if (!label) continue
    if (!value) value = slugifyValue(label, prefix)
    if (seen.has(value)) continue
    seen.add(value)
    out.push({ value, label })
  }
  return out
}

async function listCatalogOptions(pool, hotelId) {
  const result = await pool.query(
    `SELECT kind, value, label, sort_order
     FROM hotel_catalog_options
     WHERE hotel_id = $1
     ORDER BY kind, sort_order ASC, lower(label) ASC`,
    [hotelId]
  )
  const location_types = []
  const view_types = []
  for (const row of result.rows) {
    const item = { value: row.value, label: row.label }
    if (row.kind === 'location_type') location_types.push(item)
    else if (row.kind === 'view_type') view_types.push(item)
  }
  return {
    location_types: location_types.length ? location_types : defaultOptions('location_type'),
    view_types: view_types.length ? view_types : defaultOptions('view_type'),
    using_defaults: {
      location_type: location_types.length === 0,
      view_type: view_types.length === 0,
    },
  }
}

async function replaceCatalogKind(pool, hotelId, kind, options) {
  if (!KINDS.has(kind)) {
    const err = new Error('ชนิดตัวเลือกไม่ถูกต้อง')
    err.status = 400
    throw err
  }
  const list = sanitizeOptionsList(kind, options)
  if (!list.length) {
    const err = new Error(kind === 'view_type' ? 'ต้องมีวิวอย่างน้อย 1 รายการ' : 'ต้องมีลักษณะที่ตั้งอย่างน้อย 1 รายการ')
    err.status = 400
    throw err
  }
  await pool.query(
    `DELETE FROM hotel_catalog_options WHERE hotel_id = $1 AND kind = $2`,
    [hotelId, kind]
  )
  const values = []
  const params = [hotelId, kind]
  list.forEach((item, i) => {
    params.push(item.value, item.label, i)
    const base = params.length
    values.push(`($1, $2, $${base - 2}, $${base - 1}, $${base})`)
  })
  await pool.query(
    `INSERT INTO hotel_catalog_options (hotel_id, kind, value, label, sort_order)
     VALUES ${values.join(', ')}`,
    params
  )
  return list
}

async function saveCatalogOptions(pool, hotelId, body = {}) {
  const hasLoc = Object.prototype.hasOwnProperty.call(body, 'location_types')
  const hasView = Object.prototype.hasOwnProperty.call(body, 'view_types')
  if (!hasLoc && !hasView) {
    const err = new Error('ระบุ location_types หรือ view_types')
    err.status = 400
    throw err
  }
  if (hasLoc) await replaceCatalogKind(pool, hotelId, 'location_type', body.location_types)
  if (hasView) await replaceCatalogKind(pool, hotelId, 'view_type', body.view_types)
  return listCatalogOptions(pool, hotelId)
}

function labelForValue(options, value) {
  const key = String(value || '').trim()
  if (!key) return ''
  return (options || []).find((o) => o.value === key)?.label || ''
}

function allowedValues(options) {
  return new Set((options || []).map((o) => o.value))
}

async function resolveLocationType(pool, hotelId, value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const { location_types } = await listCatalogOptions(pool, hotelId)
  return allowedValues(location_types).has(raw) ? raw : null
}

async function resolveViewType(pool, hotelId, value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const { view_types } = await listCatalogOptions(pool, hotelId)
  if (!allowedValues(view_types).has(raw)) return undefined
  return raw
}

async function attachCatalogLabels(pool, hotelId, hotelRow) {
  if (!hotelRow) return null
  const opts = await listCatalogOptions(pool, hotelId)
  const shaped = { ...hotelRow }
  shaped.location_type = shaped.location_type ? String(shaped.location_type) : null
  if (shaped.location_type && !allowedValues(opts.location_types).has(shaped.location_type)) {
    // keep stored value but show empty label if removed from catalog
  }
  shaped.location_type_label = labelForValue(opts.location_types, shaped.location_type) || null
  shaped.about_hotel = shaped.about_hotel == null ? '' : String(shaped.about_hotel)
  shaped.catalog_options = {
    location_types: opts.location_types,
    view_types: opts.view_types,
  }
  return shaped
}

async function viewLabelMap(pool, hotelId) {
  const { view_types } = await listCatalogOptions(pool, hotelId)
  return Object.fromEntries(view_types.map((o) => [o.value, o.label]))
}

module.exports = {
  DEFAULT_VIEW_TYPE_OPTIONS,
  defaultOptions,
  listCatalogOptions,
  saveCatalogOptions,
  labelForValue,
  resolveLocationType,
  resolveViewType,
  attachCatalogLabels,
  viewLabelMap,
}
