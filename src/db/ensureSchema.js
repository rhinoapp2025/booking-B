const { getPool } = require('./pool')

// ─── helpers ──────────────────────────────────────────────────────────────────

async function ensurePaymentSlipsSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_payment_slips (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id           UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      hotel_id             UUID NOT NULL REFERENCES hotels(id)   ON DELETE CASCADE,
      slip_filename        TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'cancelled')),
      uploaded_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at          TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_payment_slips_booking
      ON booking_payment_slips (booking_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_booking_payment_slips_hotel_created
      ON booking_payment_slips (hotel_id, created_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_booking_payment_slips_status
      ON booking_payment_slips (status, created_at DESC)
  `)
  await pool.query(`ALTER TABLE booking_payment_slips DROP CONSTRAINT IF EXISTS booking_payment_slips_status_check`)
  await pool.query(`
    ALTER TABLE booking_payment_slips
      ADD CONSTRAINT booking_payment_slips_status_check
      CHECK (status IN ('pending', 'confirmed', 'cancelled', 'approved', 'rejected'))
  `)
}

async function ensureFcmTokensSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       TEXT NOT NULL,
      platform    TEXT NOT NULL DEFAULT 'web'
        CHECK (platform IN ('web', 'android', 'ios')),
      enabled     BOOLEAN NOT NULL DEFAULT true,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true`)
  await pool.query(`ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_fcm_tokens_user_token
      ON fcm_tokens (user_id, token)
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_fcm_tokens_token
      ON fcm_tokens (token)
  `)
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function ensureSchema() {
  const pool = await getPool()

  // ── core auth ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name         TEXT NOT NULL,
      email        TEXT,
      phone        TEXT,
      avatar_url   TEXT,
      provider     TEXT NOT NULL
        CHECK (provider IN ('google', 'facebook', 'line', 'phone', 'system')),
      provider_id  TEXT NOT NULL,
      is_admin     BOOLEAN NOT NULL DEFAULT false,
      is_super_admin BOOLEAN NOT NULL DEFAULT false,
      total_points INT     NOT NULL DEFAULT 0,
      admin_note   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_title TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_first_name TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_last_name TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_sex TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_nation TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_national_id TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_passport TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_birthday DATE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_phone TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_car_no TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_address1 TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_address2 TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_address3 TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_special_requests TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_id TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`)
  await pool.query(`
    UPDATE users
       SET login_id = provider_id
     WHERE provider = 'phone'
       AND (login_id IS NULL OR trim(login_id) = '')
       AND provider_id IS NOT NULL
       AND trim(provider_id) <> ''
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_id
      ON users (lower(trim(login_id)))
      WHERE login_id IS NOT NULL AND trim(login_id) <> ''
  `)
  // บัญชีเบอร์เดิมที่ยังไม่มีรหัส: ตั้งรหัสเริ่มต้น = เบอร์ (login_id) ให้เข้าได้ก่อนแล้วค่อยเปลี่ยนในโปรไฟล์
  {
    const { hashPassword } = require('../utils/passwordAuth')
    const legacy = await pool.query(
      `SELECT id, COALESCE(NULLIF(trim(login_id), ''), provider_id) AS seed
         FROM users
        WHERE provider = 'phone'
          AND password_hash IS NULL
          AND COALESCE(NULLIF(trim(login_id), ''), provider_id) IS NOT NULL
          AND trim(COALESCE(NULLIF(trim(login_id), ''), provider_id)) <> ''`
    )
    for (const row of legacy.rows) {
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash IS NULL`, [
        hashPassword(row.seed),
        row.id,
      ])
    }
  }
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_provider_provider_id_key`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_oauth_provider
      ON users (provider, provider_id)
      WHERE provider <> 'phone'
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone_identity
      ON users (provider, provider_id, lower(trim(name)))
      WHERE provider = 'phone'
  `)

  // ── hotel (tenant) ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotels (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug             TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      description      TEXT,
      address          TEXT,
      city             TEXT,
      province         TEXT,
      country          TEXT NOT NULL DEFAULT 'Thailand',
      phone            TEXT,
      email            TEXT,
      website          TEXT,
      star_rating      SMALLINT CHECK (star_rating BETWEEN 1 AND 1000),
      check_in_time    TEXT NOT NULL DEFAULT '14:00',
      check_out_time   TEXT NOT NULL DEFAULT '12:00',
      cover_image      TEXT,
      images           JSONB  NOT NULL DEFAULT '[]',
      latitude         NUMERIC(9, 6),
      longitude        NUMERIC(9, 6),
      map_url          TEXT,
      map_embed_url    TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE hotels ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`ALTER TABLE hotels ADD COLUMN IF NOT EXISTS map_embed_url TEXT`)
  await pool.query(`ALTER TABLE hotels ADD COLUMN IF NOT EXISTS location_type TEXT`)
  await pool.query(`ALTER TABLE hotels ADD COLUMN IF NOT EXISTS about_hotel TEXT`)
  await pool.query(`ALTER TABLE hotels ADD COLUMN IF NOT EXISTS line_url TEXT`)
  await pool.query(`ALTER TABLE hotels DROP CONSTRAINT IF EXISTS hotels_location_type_check`)
  await pool.query(`ALTER TABLE hotels DROP CONSTRAINT IF EXISTS hotels_star_rating_check`)
  await pool.query(`
    ALTER TABLE hotels
      ADD CONSTRAINT hotels_star_rating_check
      CHECK (star_rating IS NULL OR (star_rating BETWEEN 1 AND 1000))
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotel_admins (
      hotel_id  UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      user_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      PRIMARY KEY (hotel_id, user_id)
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotel_settings (
      hotel_id      UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      setting_key   TEXT NOT NULL,
      setting_value TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (hotel_id, setting_key)
    )
  `)

  // ── room types (e.g. Standard, Deluxe, Suite) ──────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_types (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id         UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      description      TEXT,
      price_per_night  NUMERIC(10, 2) NOT NULL DEFAULT 0,
      max_adults       SMALLINT NOT NULL DEFAULT 2,
      max_children     SMALLINT NOT NULL DEFAULT 1,
      bed_type         TEXT NOT NULL DEFAULT 'double'
        CHECK (bed_type IN ('single', 'double', 'twin', 'king', 'queen', 'bunk')),
      size_sqm         NUMERIC(6, 2),
      images           JSONB  NOT NULL DEFAULT '[]',
      amenities        JSONB  NOT NULL DEFAULT '[]',
      is_active        BOOLEAN NOT NULL DEFAULT true,
      sort_order       INT     NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_room_types_hotel_name
      ON room_types (hotel_id, name)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_room_types_hotel_active
      ON room_types (hotel_id, is_active, sort_order)
  `)

  // ── rooms (physical rooms: 101, 102 …) ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id      UUID NOT NULL REFERENCES hotels(id)      ON DELETE CASCADE,
      room_type_id  UUID NOT NULL REFERENCES room_types(id)  ON DELETE RESTRICT,
      room_number   TEXT NOT NULL,
      floor         SMALLINT,
      status        TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'maintenance', 'inactive')),
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`ALTER TABLE room_types ADD COLUMN IF NOT EXISTS view_type TEXT`)
  await pool.query(`ALTER TABLE room_types DROP CONSTRAINT IF EXISTS room_types_view_type_check`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotel_catalog_options (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id    UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('location_type', 'view_type')),
      value       TEXT NOT NULL,
      label       TEXT NOT NULL,
      sort_order  INT NOT NULL DEFAULT 0,
      UNIQUE (hotel_id, kind, value)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_hotel_catalog_options_hotel_kind
      ON hotel_catalog_options (hotel_id, kind, sort_order)
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_hotel_number
      ON rooms (hotel_id, room_number)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_rooms_hotel_type
      ON rooms (hotel_id, room_type_id)
  `)

  // ── bookings ───────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id          UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      user_id           UUID NOT NULL REFERENCES users(id),
      check_in_date     DATE NOT NULL,
      check_out_date    DATE NOT NULL,
      num_adults        SMALLINT NOT NULL DEFAULT 1 CHECK (num_adults >= 1),
      num_children      SMALLINT NOT NULL DEFAULT 0 CHECK (num_children >= 0),
      status            TEXT NOT NULL DEFAULT 'awaiting_payment'
        CHECK (status IN (
          'awaiting_payment',
          'pending',
          'confirmed',
          'checked_in',
          'checked_out',
          'cancelled'
        )),
      total_price       NUMERIC(10, 2),
      deposit_amount    NUMERIC(10, 2),
      special_requests  TEXT,
      guest_name        TEXT,
      guest_phone       TEXT,
      guest_email       TEXT,
      cancelled_reason  TEXT,
      cancelled_by      TEXT CHECK (cancelled_by IN ('user', 'admin', 'system')),
      cancelled_at      TIMESTAMPTZ,
      chat_admin_upcoming_sent_at    TIMESTAMPTZ,
      chat_customer_upcoming_sent_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (check_out_date > check_in_date)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_bookings_hotel_status
      ON bookings (hotel_id, status, check_in_date)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_bookings_user
      ON bookings (user_id, created_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_bookings_dates
      ON bookings (hotel_id, check_in_date, check_out_date)
      WHERE status <> 'cancelled'
  `)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS chat_admin_upcoming_sent_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS chat_customer_upcoming_sent_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_title TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_first_name TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_last_name TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_sex TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_nation TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_national_id TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_passport TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_birthday DATE`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_car_no TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_address1 TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_address2 TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_address3 TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pms_resv_no TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pms_room_no TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pms_sent_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pms_last_error TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pms_ota_booking_no TEXT`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS include_breakfast BOOLEAN NOT NULL DEFAULT false`)
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS breakfast_count SMALLINT NOT NULL DEFAULT 0`)

  // ── booking_rooms (rooms assigned to a booking) ────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_rooms (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id       UUID NOT NULL REFERENCES bookings(id)   ON DELETE CASCADE,
      room_id          UUID REFERENCES rooms(id)               ON DELETE RESTRICT,
      room_type_id     UUID NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
      price_per_night  NUMERIC(10, 2) NOT NULL,
      nights           SMALLINT NOT NULL CHECK (nights >= 1),
      subtotal         NUMERIC(10, 2) NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE booking_rooms ALTER COLUMN room_id DROP NOT NULL`)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_rooms_booking_room
      ON booking_rooms (booking_id, room_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_booking_rooms_room
      ON booking_rooms (room_id, booking_id)
  `)

  // ── room_blocks (close a room or whole hotel for a period) ─────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_blocks (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id         UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      room_id          UUID REFERENCES rooms(id) ON DELETE CASCADE,
      block_date_from  DATE NOT NULL,
      block_date_to    DATE NOT NULL,
      reason           TEXT NOT NULL DEFAULT 'maintenance'
        CHECK (reason IN ('maintenance', 'renovation', 'reserved', 'other')),
      note             TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (block_date_to > block_date_from)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_room_blocks_hotel_dates
      ON room_blocks (hotel_id, block_date_from, block_date_to)
  `)

  // ── room_prices (seasonal / promotional pricing overrides) ─────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_prices (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_type_id     UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      date_from        DATE NOT NULL,
      date_to          DATE NOT NULL,
      price_per_night  NUMERIC(10, 2) NOT NULL CHECK (price_per_night >= 0),
      label            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (date_to > date_from)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_room_prices_type_dates
      ON room_prices (room_type_id, date_from, date_to)
  `)

  // ── channel manager (PMS web allotment + rate plans) ───────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_plans (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id             UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      is_active            BOOLEAN NOT NULL DEFAULT true,
      includes_breakfast   BOOLEAN NOT NULL DEFAULT false,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_rate_plans_hotel_name
      ON rate_plans (hotel_id, lower(trim(name)))
  `)
  await pool.query(`
    ALTER TABLE rate_plans
      ADD COLUMN IF NOT EXISTS includes_breakfast BOOLEAN NOT NULL DEFAULT false
  `)
  await pool.query(`
    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS rate_plan_id UUID REFERENCES rate_plans(id) ON DELETE SET NULL
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_type_rate_plans (
      hotel_id      UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      room_type_id  UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      rate_plan_id  UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_type_id, rate_plan_id)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_rtrp_hotel_plan
      ON room_type_rate_plans (hotel_id, rate_plan_id)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_allotments (
      hotel_id       UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      room_type_id   UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      stay_date      DATE NOT NULL,
      rooms_to_sell  SMALLINT NOT NULL CHECK (rooms_to_sell >= 0 AND rooms_to_sell <= 9999),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (hotel_id, room_type_id, stay_date)
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_rates (
      hotel_id      UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      room_type_id  UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      rate_plan_id  UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
      stay_date     DATE NOT NULL,
      price         NUMERIC(10, 2) CHECK (price IS NULL OR price >= 0),
      abf           NUMERIC(10, 2) CHECK (abf IS NULL OR abf >= 0),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (hotel_id, room_type_id, rate_plan_id, stay_date)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_channel_rates_lookup
      ON channel_rates (hotel_id, room_type_id, stay_date)
  `)
  await pool.query(`
    ALTER TABLE channel_rates
      ADD COLUMN IF NOT EXISTS abf NUMERIC(10, 2)
  `)
  await pool.query(`
    ALTER TABLE channel_rates ALTER COLUMN price DROP NOT NULL
  `)
  await pool.query(`
    ALTER TABLE channel_rates
      ADD COLUMN IF NOT EXISTS display_price NUMERIC(10, 2)
  `)
  await pool.query(`
    ALTER TABLE channel_rates
      DROP CONSTRAINT IF EXISTS channel_rates_display_price_check
  `)
  await pool.query(`
    ALTER TABLE channel_rates
      ADD CONSTRAINT channel_rates_display_price_check
      CHECK (display_price IS NULL OR display_price >= 0)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_stop_sales (
      hotel_id      UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      room_type_id  UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      rate_plan_id  UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
      stay_date     DATE NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (hotel_id, room_type_id, rate_plan_id, stay_date)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_channel_stop_sales_lookup
      ON channel_stop_sales (hotel_id, room_type_id, stay_date)
  `)

  // ── reviews ────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id            UUID NOT NULL REFERENCES hotels(id)   ON DELETE CASCADE,
      booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      user_id             UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      cleanliness_rating  SMALLINT CHECK (cleanliness_rating BETWEEN 1 AND 5),
      service_rating      SMALLINT CHECK (service_rating BETWEEN 1 AND 5),
      location_rating     SMALLINT CHECK (location_rating BETWEEN 1 AND 5),
      comment             TEXT,
      images              JSONB NOT NULL DEFAULT '[]',
      is_visible          BOOLEAN NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_reviews_booking
      ON reviews (booking_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_reviews_hotel_visible
      ON reviews (hotel_id, is_visible, created_at DESC)
  `)

  // ── loyalty ────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS point_logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id),
      booking_id  UUID REFERENCES bookings(id),
      points      INT  NOT NULL,
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id),
      hotel_id          UUID REFERENCES hotels(id) ON DELETE CASCADE,
      coupon_code       TEXT NOT NULL,
      discount_type     TEXT NOT NULL DEFAULT 'percent'
        CHECK (discount_type IN ('percent', 'baht')),
      discount_value    NUMERIC(10, 2) NOT NULL DEFAULT 10,
      required_points   INT NOT NULL DEFAULT 100,
      min_nights        SMALLINT NOT NULL DEFAULT 1,
      is_used           BOOLEAN NOT NULL DEFAULT false,
      used_at           TIMESTAMPTZ,
      expires_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_coupons_coupon_code
      ON coupons (coupon_code)
  `)
  await pool.query(`ALTER TABLE coupons ADD COLUMN IF NOT EXISTS hotel_id UUID REFERENCES hotels(id) ON DELETE CASCADE`)
  await pool.query(`ALTER TABLE coupons ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(10, 2)`)
  await pool.query(`ALTER TABLE coupons ADD COLUMN IF NOT EXISTS discount_type TEXT`)
  await pool.query(`ALTER TABLE coupons ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10, 2)`)
  await pool.query(`
    UPDATE coupons
       SET discount_percent = discount_value
     WHERE discount_percent IS NULL AND discount_value IS NOT NULL
  `)
  await pool.query(`
    UPDATE coupons
       SET discount_value = discount_percent
     WHERE discount_value IS NULL AND discount_percent IS NOT NULL
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_hotel_points (
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hotel_id    UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      points      INT  NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, hotel_id)
    )
  `)
  await pool.query(`ALTER TABLE point_logs ADD COLUMN IF NOT EXISTS hotel_id UUID REFERENCES hotels(id) ON DELETE SET NULL`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_point_logs_user_hotel
      ON point_logs (user_id, hotel_id, created_at DESC)
  `)
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_point_logs_checkout_booking
        ON point_logs (booking_id)
        WHERE booking_id IS NOT NULL AND note = 'checkout'
    `)
  } catch (err) {
    console.warn('ux_point_logs_checkout_booking skipped:', err.message)
  }

  // ── chat ───────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id     UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      sender_role  TEXT NOT NULL CHECK (sender_role IN ('admin', 'customer', 'system')),
      sender_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      body         TEXT NOT NULL DEFAULT '',
      image_url    TEXT,
      read_at      TIMESTAMPTZ,
      related_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_chat_messages_hotel_user_created
      ON chat_messages (hotel_id, user_id, created_at ASC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_chat_messages_unread
      ON chat_messages (hotel_id, user_id)
      WHERE sender_role = 'customer' AND read_at IS NULL
  `)
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS related_user_id UUID REFERENCES users(id) ON DELETE SET NULL`)

  // ── fcm & payment slips ────────────────────────────────────────────────────
  await ensureFcmTokensSchema(pool)
  await ensurePaymentSlipsSchema(pool)

  // ── global app_settings (fallback defaults) ────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key    TEXT PRIMARY KEY,
      setting_value  TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // ── seed default hotel ─────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO hotels (slug, name, description, city, province, star_rating)
    VALUES ('default', 'My Hotel', 'โรงแรมตัวอย่าง', 'กรุงเทพมหานคร', 'กรุงเทพมหานคร', NULL)
    ON CONFLICT (slug) DO NOTHING
  `)

  const hotelRow = await pool.query(`SELECT id FROM hotels WHERE slug = 'default' LIMIT 1`)
  const defaultHotelId = hotelRow.rows[0]?.id
  if (!defaultHotelId) throw new Error('Default hotel missing after migration')

  await pool.query(
    `INSERT INTO user_hotel_points (user_id, hotel_id, points)
     SELECT u.id, $1, u.total_points
       FROM users u
      WHERE u.total_points > 0
        AND NOT EXISTS (
          SELECT 1 FROM user_hotel_points uhp WHERE uhp.user_id = u.id
        )
     ON CONFLICT (user_id, hotel_id) DO NOTHING`,
    [defaultHotelId]
  )
  await pool.query(
    `UPDATE coupons SET hotel_id = $1 WHERE hotel_id IS NULL`,
    [defaultHotelId]
  )

  // ── seed default hotel_settings ────────────────────────────────────────────
  await pool.query(`
    INSERT INTO hotel_settings (hotel_id, setting_key, setting_value)
    SELECT $1, d.key, d.val
    FROM (VALUES
      ('deposit_percent',           '30'),
      ('payment_collect_mode',      'deposit'),
      ('auto_cancel_hours',         '24'),
      ('cancellation_policy',       ''),
      ('non_smoking',               'false'),
      ('non_smoking_fine',          '0'),
      ('require_id_card',           'false'),
      ('book_advance_days',         '90'),
      ('coupon_discount_percent',   '10'),
      ('coupon_required_points',    '100'),
      ('coupon_completion_points',  '5'),
      ('line_push_enabled',         'false'),
      ('promptpay_number',          ''),
      ('bank_name',                 ''),
      ('bank_account_name',         ''),
      ('bank_account_no',           ''),
      ('unpaid_auto_cancel_enabled','true')
    ) AS d(key, val)
    ON CONFLICT (hotel_id, setting_key) DO NOTHING
  `, [defaultHotelId])

  // ── seed room types (if none exist for this hotel) ─────────────────────────
  const rtCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM room_types WHERE hotel_id = $1`,
    [defaultHotelId]
  )
  if (rtCount.rows[0].n === 0) {
    await pool.query(`
      INSERT INTO room_types (hotel_id, name, description, price_per_night, max_adults, max_children, bed_type, sort_order)
      VALUES
        ($1, 'Standard', 'ห้องมาตรฐาน พร้อม AC และ TV',     1200, 2, 1, 'double', 1),
        ($1, 'Deluxe',   'ห้อง Deluxe วิวสระน้ำ',           1800, 2, 1, 'king',   2),
        ($1, 'Suite',    'ห้อง Suite ห้องรับแขกแยก วิวเมือง', 3500, 2, 2, 'king',   3)
    `, [defaultHotelId])
  }

  // ── seed rooms (if none exist for this hotel) ──────────────────────────────
  const roomCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rooms WHERE hotel_id = $1`,
    [defaultHotelId]
  )
  if (roomCount.rows[0].n === 0) {
    const types = await pool.query(
      `SELECT id, name FROM room_types WHERE hotel_id = $1 ORDER BY sort_order`,
      [defaultHotelId]
    )
    const byName = Object.fromEntries(types.rows.map(r => [r.name, r.id]))

    const seedRooms = [
      { number: '101', floor: 1, type: 'Standard' },
      { number: '102', floor: 1, type: 'Standard' },
      { number: '103', floor: 1, type: 'Standard' },
      { number: '201', floor: 2, type: 'Deluxe' },
      { number: '202', floor: 2, type: 'Deluxe' },
      { number: '301', floor: 3, type: 'Suite' },
    ]

    for (const r of seedRooms) {
      if (!byName[r.type]) continue
      await pool.query(
        `INSERT INTO rooms (hotel_id, room_type_id, room_number, floor)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [defaultHotelId, byName[r.type], r.number, r.floor]
      )
    }
  }

  // ── wire admins to default hotel ───────────────────────────────────────────
  await pool.query(`
    INSERT INTO hotel_admins (hotel_id, user_id)
    SELECT $1, u.id
    FROM users u
    WHERE u.is_admin = true
      AND NOT EXISTS (
        SELECT 1 FROM hotel_admins ha
        WHERE ha.user_id = u.id AND ha.hotel_id = $1
      )
    ON CONFLICT DO NOTHING
  `, [defaultHotelId])

  const superAdmin = await pool.query(`SELECT 1 FROM users WHERE is_super_admin = true LIMIT 1`)
  if (!superAdmin.rows[0]) {
    const { ensureBootstrapSuperAdmin } = require('../utils/ensureBootstrapSuperAdmin')
    await ensureBootstrapSuperAdmin(pool)
  }

  const stillNoSuper = await pool.query(`SELECT 1 FROM users WHERE is_super_admin = true LIMIT 1`)
  if (!stillNoSuper.rows[0]) {
    await pool.query(`UPDATE users SET is_super_admin = true WHERE is_admin = true`)
  }

  console.log('✅ PostgreSQL schema ready (hotel booking)')
}

module.exports = {
  ensureSchema,
  ensurePaymentSlipsSchema,
  ensureFcmTokensSchema,
}
