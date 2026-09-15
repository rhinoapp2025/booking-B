const router = require('express').Router()
const auth   = require('../middleware/authMiddleware')
const { getPool } = require('../db/pool')
const { isFcmConfigured } = require('../utils/fcmPush')
const {
  upsertFcmToken, disableFcmToken, disableAllFcmTokensForUser,
  getUserPushStatus, getTokenPushStatus,
} = require('../utils/fcmTokens')

router.use(auth)

router.get('/status', async (req, res) => {
  try {
    const pool  = getPool()
    const token = String(req.query.token || '').trim()
    const enabled = token
      ? await getTokenPushStatus(pool, req.user.id, token)
      : await getUserPushStatus(pool, req.user.id)
    res.json({ configured: isFcmConfigured(), enabled })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/token', async (req, res) => {
  const token   = String(req.body?.token || '').trim()
  const enabled = req.body?.enabled !== false
  if (!token) return res.status(400).json({ error: 'token จำเป็น' })
  if (!isFcmConfigured()) return res.status(503).json({ error: 'ระบบ push ยังไม่ได้ตั้งค่า' })
  try {
    const pool = getPool()
    if (!enabled) {
      await disableFcmToken(pool, { userId: req.user.id, token })
      return res.json({ ok: true, enabled: false })
    }
    const row = await upsertFcmToken(pool, {
      userId: req.user.id, token, enabled: true,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    })
    res.json({ ok: true, enabled: Boolean(row?.enabled) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/disable', async (req, res) => {
  try {
    const pool  = getPool()
    const token = String(req.body?.token || '').trim()
    if (token) {
      await disableFcmToken(pool, { userId: req.user.id, token })
    } else {
      await disableAllFcmTokensForUser(pool, req.user.id)
    }
    res.json({ ok: true, enabled: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
