const { getHotelSettings } = require('./hotelSettings')
const { firstRoomImage, resolveRoomTypeImages } = require('./roomTypeImages')

function typeFitsParty(type, adults, children) {
  const maxA = Number(type.max_adults)
  const maxC = Number(type.max_children)
  if (Number.isFinite(maxA) && maxA > 0 && adults > maxA) return false
  if (Number.isFinite(maxC) && maxC > 0 && children > maxC) return false
  return true
}

function stayNightPrice(type) {
  return Number(type?.price_per_night || 0)
}

function normTypeName(name) {
  return String(name || '').trim().toUpperCase()
}

async function resolveHotelSlug(pool, hotelId, hint) {
  const slug = String(hint || '').trim()
  if (slug) return slug
  const row = await pool.query(`SELECT slug FROM hotels WHERE id = $1 LIMIT 1`, [hotelId])
  return row.rows[0]?.slug || 'default'
}

function shapeTypeImages(rt, slug) {
  const storedImages = Array.isArray(rt.images) ? rt.images : []
  const images = resolveRoomTypeImages(storedImages, {
    slug,
    roomTypeId: rt.id,
    typeName: rt.name,
  })
  return {
    images,
    cover_image: images[0] || firstRoomImage(storedImages, rt.name, {
      slug,
      roomTypeId: rt.id,
    }),
  }
}

async function typesFromPmsSellable(pool, hotelId, sellableByType, kioskRooms, adults, children, hotelSlug) {
  const sellable = {}
  for (const [name, count] of Object.entries(sellableByType || {})) {
    const key = normTypeName(name)
    if (key) sellable[key] = Number(count)
  }
  const pgTypes = await pool.query(
    `SELECT id, name, description, price_per_night, max_adults, max_children,
            bed_type, size_sqm, images, amenities, view_type
     FROM room_types
     WHERE hotel_id = $1 AND is_active = true
     ORDER BY sort_order ASC, name ASC`,
    [hotelId]
  )
  const roomsByTypeId = {}
  for (const row of kioskRooms || []) {
    if (!roomsByTypeId[row.room_type_id]) roomsByTypeId[row.room_type_id] = []
    roomsByTypeId[row.room_type_id].push({
      room_id: row.room_id,
      room_number: row.room_number,
      floor: row.floor,
    })
  }
  const types = []
  for (const rt of pgTypes.rows) {
    const n = Number(sellable[normTypeName(rt.name)])
    if (!Number.isFinite(n) || n <= 0) continue
    if (!typeFitsParty(rt, adults, children)) continue
    const imgs = shapeTypeImages(rt, hotelSlug)
    types.push({
      id: rt.id,
      name: rt.name,
      description: rt.description || null,
      price_per_night: rt.price_per_night,
      max_adults: rt.max_adults,
      max_children: rt.max_children,
      bed_type: rt.bed_type,
      size_sqm: rt.size_sqm,
      view_type: rt.view_type || null,
      images: imgs.images,
      cover_image: imgs.cover_image,
      amenities: rt.amenities,
      available_count: n,
      rooms: roomsByTypeId[rt.id] || [],
    })
  }
  return types
}

function cheapestRoomType(types) {
  if (!types?.length) return null
  return types.reduce((best, row) => {
    if (!best) return row
    return stayNightPrice(row) < stayNightPrice(best) ? row : best
  }, null)
}

/** จองที่ยึดเลขห้องในคลัง PG — เช็คเอาต์ / ยกเลิก / ไม่มา ไม่ยึดห้องแล้ว */
const ROOM_HOLD_STATUS_SQL = `b.status NOT IN ('cancelled', 'checked_out', 'no_show')`

async function getAvailableRoomTypes(pool, hotelId, { checkIn, checkOut, adults = 1, children = 0, hotelSlug } = {}) {
  const adultsN = Math.max(1, Number(adults) || 1)
  const childrenN = Math.max(0, Number(children) || 0)
  const slug = await resolveHotelSlug(pool, hotelId, hotelSlug)

  const bookedRooms = await pool.query(
    `SELECT DISTINCT br.room_id
     FROM booking_rooms br
     JOIN bookings b ON b.id = br.booking_id
     WHERE b.hotel_id = $1
       AND ${ROOM_HOLD_STATUS_SQL}
       AND b.check_in_date  < $3
       AND b.check_out_date > $2`,
    [hotelId, checkIn, checkOut]
  )
  const bookedRoomIds = bookedRooms.rows.map((r) => r.room_id)
  const bookedSet = new Set(bookedRoomIds)

  const params = [hotelId]
  const notBooked = bookedRoomIds.length
    ? `AND r.id NOT IN (${bookedRoomIds.map((_, i) => `$${i + 2}`).join(',')})`
    : ''
  if (bookedRoomIds.length) params.push(...bookedRoomIds)

  const availableRooms = await pool.query(
    `SELECT r.id AS room_id, r.room_number, r.floor,
            rt.id AS room_type_id, rt.name AS room_type_name,
            rt.description, rt.price_per_night, rt.max_adults, rt.max_children,
            rt.bed_type, rt.size_sqm, rt.images, rt.amenities, rt.view_type
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.hotel_id = $1
       AND r.status = 'available'
       AND rt.is_active = true
       ${notBooked}
     ORDER BY rt.sort_order ASC, r.floor ASC, r.room_number ASC`,
    params
  )

  let kioskSyncedRooms = null
  let pmsSellableByType = null
  try {
    const kioskSettings = await getHotelSettings(pool, hotelId, [
      'kiosk_enabled', 'kiosk_db_name', 'kiosk_hotel_id', 'kiosk_com_no',
    ])
    const kioskEnabled = kioskSettings.kiosk_enabled === 'true'
    const hasConfig = kioskSettings.kiosk_db_name && kioskSettings.kiosk_hotel_id && kioskSettings.kiosk_com_no

    if (kioskEnabled && hasConfig) {
      const {
        getKioskVacantRooms, ensureKioskRoomsInPg, getKioskStaySellableByType,
      } = require('./kioskVacantRooms')
      const kioskRooms = await getKioskVacantRooms({
        dbName: kioskSettings.kiosk_db_name,
        hotelID: kioskSettings.kiosk_hotel_id,
        comNo: kioskSettings.kiosk_com_no,
        startDate: new Date(`${checkIn}T00:00:00+07:00`),
        endDate: new Date(`${checkOut}T00:00:00+07:00`),
        filterVC: false,
      })
      kioskSyncedRooms = await ensureKioskRoomsInPg(pool, hotelId, kioskRooms)
      pmsSellableByType = await getKioskStaySellableByType({
        dbName: kioskSettings.kiosk_db_name,
        hotelID: kioskSettings.kiosk_hotel_id,
        comNo: kioskSettings.kiosk_com_no,
        checkIn,
        checkOut,
      })
    }
  } catch (kioskErr) {
    console.warn('[rooms] kiosk filter failed, skipping:', kioskErr.message)
  }

  let types
  if (pmsSellableByType && Object.keys(pmsSellableByType).length) {
    types = await typesFromPmsSellable(
      pool, hotelId, pmsSellableByType, kioskSyncedRooms, adultsN, childrenN, slug,
    )
  } else {
    const sourceRows = availableRooms.rows
    const typeMap = {}
    for (const row of sourceRows) {
      if (bookedSet.has(row.room_id)) continue
      if (!typeMap[row.room_type_id]) {
        const imgs = shapeTypeImages({
          id: row.room_type_id,
          name: row.room_type_name,
          images: row.images,
        }, slug)
        typeMap[row.room_type_id] = {
          id: row.room_type_id,
          name: row.room_type_name,
          description: row.description || null,
          price_per_night: row.price_per_night,
          max_adults: row.max_adults,
          max_children: row.max_children,
          bed_type: row.bed_type,
          size_sqm: row.size_sqm,
          view_type: row.view_type || null,
          images: imgs.images,
          cover_image: imgs.cover_image,
          amenities: row.amenities,
          available_count: 0,
          rooms: [],
        }
      }
      typeMap[row.room_type_id].available_count++
      typeMap[row.room_type_id].rooms.push({
        room_id: row.room_id,
        room_number: row.room_number,
        floor: row.floor,
      })
    }
    types = Object.values(typeMap).filter((t) => typeFitsParty(t, adultsN, childrenN))
  }

  // ราคาขายจาก channel manager เท่านั้น — ไม่ดึงเรท PMS / ราคาตั้งค่าประเภทห้อง
  try {
    const { applyChannelToTypes } = require('./channelManager')
    if (types.length) {
      types = await applyChannelToTypes(pool, hotelId, types, checkIn, checkOut)
    }
  } catch (chErr) {
    console.warn('[rooms] channel overlay failed:', chErr.message)
    types = []
  }

  for (const t of types) {
    t.abf_per_night = 0
  }

  try {
    const { viewLabelMap } = require('./hotelCatalogOptions')
    const labels = await viewLabelMap(pool, hotelId)
    for (const t of types) {
      t.view_type_label = t.view_type ? (labels[t.view_type] || null) : null
    }
  } catch (labelErr) {
    console.warn('[rooms] view labels failed:', labelErr.message)
  }

  return { types }
}

module.exports = {
  typeFitsParty,
  cheapestRoomType,
  stayNightPrice,
  ROOM_HOLD_STATUS_SQL,
  getAvailableRoomTypes,
}
