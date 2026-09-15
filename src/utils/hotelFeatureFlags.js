const {
  ALL_FEATURE_KEYS,
  FEATURE_ITEM_MAP,
  HOTEL_FEATURE_CATALOG,
  catalogDefaultEnabled,
  featureSettingKey,
  featureDefaultSettingKey,
} = require('../constants/hotelFeatureCatalog')
const { getHotelSettings, setHotelSettings } = require('./hotelSettings')

function parseEnabled(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(s)) return false
  if (['1', 'true', 'on', 'yes'].includes(s)) return true
  return fallback
}

function buildDefaultTemplateFromMap(appSettingsMap = {}) {
  const template = {}
  for (const key of ALL_FEATURE_KEYS) {
    template[key] = parseEnabled(
      appSettingsMap[featureDefaultSettingKey(key)],
      catalogDefaultEnabled(key)
    )
  }
  return template
}

function buildResolvedFeatures(hotelSettingsMap = {}, appSettingsMap = {}) {
  const defaults = buildDefaultTemplateFromMap(appSettingsMap)
  const features = {}
  for (const key of ALL_FEATURE_KEYS) {
    const item = FEATURE_ITEM_MAP[key]
    if (item?.locked) {
      features[key] = true
      continue
    }
    features[key] = parseEnabled(hotelSettingsMap[featureSettingKey(key)], defaults[key])
  }
  return features
}

function overrideState(hotelSettingsMap = {}, key) {
  const raw = hotelSettingsMap[featureSettingKey(key)]
  if (raw === undefined || raw === null || raw === '') return null
  return parseEnabled(raw, null)
}

async function getAppSettingsMap(pool, keys) {
  if (!keys.length) return {}
  const result = await pool.query(
    `SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)`,
    [keys]
  )
  return Object.fromEntries(result.rows.map((row) => [row.setting_key, row.setting_value]))
}

async function setAppSettings(pool, kvMap) {
  for (const [key, value] of Object.entries(kvMap)) {
    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, value]
    )
  }
}

async function loadAppDefaultMap(pool) {
  return getAppSettingsMap(pool, ALL_FEATURE_KEYS.map(featureDefaultSettingKey))
}

async function resolveHotelFeatures(pool, hotelId) {
  const hotelKeys = ALL_FEATURE_KEYS.map(featureSettingKey)
  const hotelMap = await getHotelSettings(pool, hotelId, hotelKeys)
  const appMap = await loadAppDefaultMap(pool)
  return buildResolvedFeatures(hotelMap, appMap)
}

async function isHotelFeatureEnabled(pool, hotelId, itemKey) {
  const features = await resolveHotelFeatures(pool, hotelId)
  return features[itemKey] !== false
}

async function getPlatformFeatureState(pool) {
  const appMap = await loadAppDefaultMap(pool)
  const defaults = buildDefaultTemplateFromMap(appMap)
  const hotelsResult = await pool.query(
    `SELECT id, slug, name, is_active FROM hotels ORDER BY slug = 'default' DESC, name ASC`
  )

  const hotels = []
  for (const hotel of hotelsResult.rows) {
    const hotelMap = await getHotelSettings(
      pool,
      hotel.id,
      ALL_FEATURE_KEYS.map(featureSettingKey)
    )
    const overrides = {}
    for (const key of ALL_FEATURE_KEYS) overrides[key] = overrideState(hotelMap, key)
    hotels.push({
      id: hotel.id,
      slug: hotel.slug,
      name: hotel.name,
      is_active: hotel.is_active,
      features: buildResolvedFeatures(hotelMap, appMap),
      overrides,
    })
  }

  return { catalog: HOTEL_FEATURE_CATALOG, defaults, hotels }
}

async function savePlatformDefaults(pool, defaults = {}) {
  const payload = {}
  for (const key of ALL_FEATURE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue
    if (FEATURE_ITEM_MAP[key]?.locked) continue
    payload[featureDefaultSettingKey(key)] = (defaults[key] === true || defaults[key] === '1' || defaults[key] === 1) ? '1' : '0'
  }
  if (Object.keys(payload).length) await setAppSettings(pool, payload)
  return buildDefaultTemplateFromMap(await loadAppDefaultMap(pool))
}

async function saveHotelFeatureOverrides(pool, hotelId, features = {}) {
  const payload = {}
  for (const key of ALL_FEATURE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(features, key)) continue
    if (FEATURE_ITEM_MAP[key]?.locked) continue
    const value = features[key]
    if (value === null) {
      await pool.query(
        `DELETE FROM hotel_settings WHERE hotel_id = $1 AND setting_key = $2`,
        [hotelId, featureSettingKey(key)]
      )
      continue
    }
    payload[featureSettingKey(key)] = (value === true || value === '1' || value === 1) ? '1' : '0'
  }
  if (Object.keys(payload).length) await setHotelSettings(pool, hotelId, payload)
  return resolveHotelFeatures(pool, hotelId)
}

module.exports = {
  parseEnabled,
  buildDefaultTemplateFromMap,
  buildResolvedFeatures,
  resolveHotelFeatures,
  isHotelFeatureEnabled,
  getPlatformFeatureState,
  savePlatformDefaults,
  saveHotelFeatureOverrides,
  getAppSettingsMap,
  setAppSettings,
}
