require('dotenv').config()

const express = require('express')
const cors    = require('cors')
const { passport } = require('./config/passport')
const { createCorsOptions } = require('./config/cors')
const { ensureSchema, ensureFcmTokensSchema } = require('./db/ensureSchema')
const { getPool } = require('./db/pool')
const { expireUnpaidBookings } = require('./utils/unpaidExpire')
const { processUpcomingBookingReminders } = require('./utils/bookingUpcomingReminders')
const { expireOldChatImages } = require('./utils/chatImages')
const { expireBookingPaymentSlips } = require('./utils/expireBookingPaymentSlips')
const { syncAllPmsStatuses } = require('./utils/kioskSaveBooking')
const {
  ensureUploadDirs,
  getUploadRoot,
  recordStorageMarker,
  getStorageMarker,
} = require('./utils/uploadPaths')

const app = express()

app.use(cors(createCorsOptions()))
app.use(express.json({ limit: '3mb' }))
app.use(passport.initialize())

app.use('/api/auth',     require('./routes/auth'))
app.use('/api/hotels',   require('./routes/hotels'))
app.use('/api/bookings', require('./routes/bookings'))
app.use('/api/admin',    require('./routes/admin'))
app.use('/api/coupons',  require('./routes/coupons'))
app.use('/api/reviews',  require('./routes/reviews'))
app.use('/api/chat',     require('./routes/chat'))
app.use('/api/push',     require('./routes/push'))

app.get('/health', (req, res) => {
  const marker = getStorageMarker()
  res.json({
    status: 'ok',
    upload_root: getUploadRoot(),
    upload_persistent: marker.persistent,
    upload_first_seen_at: marker.firstSeenAt,
    upload_boot_count: marker.bootCount,
  })
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Server error' })
})

const PORT = process.env.PORT || 3001

async function startServer() {
  try {
    await ensureSchema()
  } catch (err) {
    console.error('⚠️ Startup DB migration warning:', err.message)
  }

  try {
    const pool = await getPool()
    await ensureFcmTokensSchema(pool)
  } catch (err) {
    console.error('⚠️ FCM schema migration warning:', err.message)
  }

  let storage = getStorageMarker()
  try {
    await ensureUploadDirs()
    storage = await recordStorageMarker()
  } catch (err) {
    console.error('⚠️ Upload directory warning:', err.message)
  }

  app.listen(PORT, () => {
    console.log(`🚀 Hotel Booking API running at http://localhost:${PORT}`)
    console.log(`📁 Upload root: ${getUploadRoot()}`)
    if (storage.bootCount > 1) {
      console.log(`💾 Storage persists across restarts (boot #${storage.bootCount}, since ${storage.firstSeenAt})`)
    }
  })

  // ยกเลิกการจองที่ไม่ชำระมัดจำภายในเวลาที่กำหนด (ทุก 5 นาที)
  setInterval(async () => {
    try {
      const pool = getPool()
      const count = await expireUnpaidBookings(pool)
      if (count > 0) console.log(`⏱️ Auto-cancelled ${count} unpaid booking(s)`)
    } catch (err) {
      console.error('expireUnpaidBookings:', err.message)
    }
  }, 5 * 60 * 1000)

  // แจ้งเตือนล่วงหน้าก่อนเช็คอิน (ทุก 1 นาที)
  async function runUpcomingReminders() {
    try {
      const pool = getPool()
      const { sentAdmin, sentCustomer } = await processUpcomingBookingReminders(pool)
      if (sentAdmin > 0 || sentCustomer > 0) {
        console.log(`🔔 Sent upcoming reminders — admin: ${sentAdmin}, customer: ${sentCustomer}`)
      }
    } catch (err) {
      console.error('processUpcomingBookingReminders:', err.message)
    }
  }
  runUpcomingReminders()
  setInterval(runUpcomingReminders, 60 * 1000)

  // ลบรูปภาพ chat เก่า (ทุก 1 ชั่วโมง)
  async function runChatImageCleanup() {
    try {
      const pool = getPool()
      const count = await expireOldChatImages(pool)
      if (count > 0) console.log(`🖼️ Removed ${count} expired chat image(s)`)
    } catch (err) {
      console.error('expireOldChatImages:', err.message)
    }
  }
  runChatImageCleanup()
  setInterval(runChatImageCleanup, 60 * 60 * 1000)

  // ลบสลิปที่หมดอายุ (ทุก 1 ชั่วโมง)
  async function runBookingSlipCleanup() {
    try {
      const pool = getPool()
      const count = await expireBookingPaymentSlips(pool)
      if (count > 0) console.log(`🧾 Removed ${count} expired booking payment slip(s)`)
    } catch (err) {
      console.error('expireBookingPaymentSlips:', err.message)
    }
  }
  runBookingSlipCleanup()
  setInterval(runBookingSlipCleanup, 60 * 60 * 1000)

  // ซิงก์สถานะจาก PMS (ResvStatus=CXL, Status=CI/CO) ทุก 2 นาที
  async function runPmsStatusSync() {
    try {
      const pool = getPool()
      const { cancelled, checkedIn, checkedOut } = await syncAllPmsStatuses(pool)
      if (cancelled > 0) console.log(`🧾 Synced ${cancelled} PMS cancellation(s)`)
      if (checkedIn > 0) console.log(`🧾 Synced ${checkedIn} PMS check-in(s)`)
      if (checkedOut > 0) console.log(`🧾 Synced ${checkedOut} PMS check-out(s)`)
    } catch (err) {
      console.error('syncAllPmsStatuses:', err.message)
    }
  }
  runPmsStatusSync()
  setInterval(runPmsStatusSync, 2 * 60 * 1000)
}

startServer()
