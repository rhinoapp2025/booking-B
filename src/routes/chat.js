const router = require('express').Router()
const auth   = require('../middleware/authMiddleware')
const { getPool } = require('../db/pool')
const { createChatMessage, buildLatestMessagesQuery } = require('../utils/chatMessages')
const { readChatImageFile, getChatImageCacheMaxAge, MIME_EXT } = require('../utils/chatImages')
const { pushAfterCustomerChatMessage, pushAfterAdminChatMessage } = require('../utils/fcmPush')
const { userManagesHotel } = require('../utils/hotelAdmins')
const { ensureSystemChatUser, isSystemChatUser, SYSTEM_USER_NAME } = require('../utils/systemChatUser')

// ── middleware: ดึง hotel จาก slug ────────────────────────────────────────────

router.param('hotelSlug', async (req, res, next, slug) => {
  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT id, slug, name FROM hotels WHERE slug = $1 AND is_active = true`, [slug]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Hotel not found' })
    req.hotel = result.rows[0]
    next()
  } catch (err) {
    next(err)
  }
})

router.use(auth)

async function isAdminForHotel(req) {
  return userManagesHotel(getPool(), req.user.id, req.hotel.id)
}

function sameUserId(a, b) {
  return String(a || '') === String(b || '')
}

router.get('/:hotelSlug/unread-count', async (req, res) => {
  try {
    const pool = getPool()
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM chat_messages
       WHERE hotel_id = $1 AND user_id = $2 AND sender_role = 'admin' AND read_at IS NULL`,
      [req.hotel.id, req.user.id]
    )
    res.json({ count: result.rows[0]?.count || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── ข้อความ ───────────────────────────────────────────────────────────────────

router.get('/:hotelSlug/messages', async (req, res) => {
  try {
    const pool = getPool()
    const targetUserId = req.query.user_id
    const admin = await isAdminForHotel(req)

    if (admin && !targetUserId) return res.json([])

    const userId = admin ? targetUserId : req.user.id
    const viewingSystem = admin && await isSystemChatUser(pool, req.hotel.id, userId)
    const roleFilter = admin
      ? (viewingSystem ? ` AND sender_role = 'system'` : ` AND sender_role IN ('customer', 'admin')`)
      : ` AND sender_role != 'system'`
    const result = await pool.query(
      buildLatestMessagesQuery({
        whereClause: `hotel_id = $1 AND user_id = $2${roleFilter}`,
      }),
      [req.hotel.id, userId]
    )

    if (admin && viewingSystem) {
      await pool.query(
        `UPDATE chat_messages SET read_at = NOW()
         WHERE hotel_id = $1 AND user_id = $2 AND sender_role = 'system' AND read_at IS NULL`,
        [req.hotel.id, userId]
      )
    } else if (admin) {
      await pool.query(
        `UPDATE chat_messages SET read_at = NOW()
         WHERE hotel_id = $1 AND user_id = $2 AND sender_role = 'customer' AND read_at IS NULL`,
        [req.hotel.id, userId]
      )
    } else {
      await pool.query(
        `UPDATE chat_messages SET read_at = NOW()
         WHERE hotel_id = $1 AND user_id = $2 AND sender_role = 'admin' AND read_at IS NULL`,
        [req.hotel.id, req.user.id]
      )
    }
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:hotelSlug/messages', async (req, res) => {
  try {
    const pool = getPool()
    const admin = await isAdminForHotel(req)
    const targetUserId = req.body?.user_id

    if (admin && !targetUserId) {
      return res.status(400).json({ error: 'กรุณาเลือกผู้ใช้ก่อนส่งข้อความ' })
    }
    if (admin && await isSystemChatUser(pool, req.hotel.id, targetUserId)) {
      return res.status(400).json({ error: 'แชทระบบเป็นแจ้งเตือนอย่างเดียว ส่งข้อความไม่ได้' })
    }

    const asAdmin = admin && targetUserId

    const row = await createChatMessage(pool, {
      hotelId:    req.hotel.id,
      userId:     asAdmin ? targetUserId : req.user.id,
      senderRole: asAdmin ? 'admin' : 'customer',
      senderId:   req.user.id,
      body:       req.body?.body ?? req.body?.message,
      imageData:  req.body?.imageData,
      imageMime:  req.body?.imageMime,
    })

    if (asAdmin) {
      pushAfterAdminChatMessage(pool, req.hotel.id, targetUserId, {
        body: row.body, imageUrl: row.image_url, messageId: row.id,
      }).catch(() => null)
    } else {
      pushAfterCustomerChatMessage(pool, req.hotel.id, {
        customerId: req.user.id, customerName: req.user.name,
        body: row.body, imageUrl: row.image_url, messageId: row.id,
      }).catch(() => null)
    }
    res.status(201).json(row)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ── admin: รายชื่อ thread ─────────────────────────────────────────────────────

async function listThreads(req, res) {
  try {
    if (!(await isAdminForHotel(req))) return res.status(403).json({ error: 'Forbidden' })
    const pool = getPool()
    const systemUserId = await ensureSystemChatUser(pool, req.hotel.id)

    const unreadRes = await pool.query(
      `SELECT COUNT(*)::int AS unread
         FROM chat_messages
        WHERE hotel_id = $1 AND user_id = $2 AND sender_role = 'system' AND read_at IS NULL`,
      [req.hotel.id, systemUserId]
    )
    const systemLast = await pool.query(
      `SELECT body, created_at
         FROM chat_messages
        WHERE hotel_id = $1 AND user_id = $2 AND sender_role = 'system'
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.hotel.id, systemUserId]
    )
    const systemThread = {
      user_id: systemUserId,
      user_name: SYSTEM_USER_NAME,
      avatar_url: null,
      last_message: systemLast.rows[0]?.body || 'แจ้งเตือนการจอง ยกเลิก และตรวจสลิป',
      last_at: systemLast.rows[0]?.created_at || null,
      unread: unreadRes.rows[0]?.unread || 0,
      is_system: true,
    }

    const humans = await pool.query(
      `SELECT DISTINCT ON (cm.user_id)
         cm.user_id, u.name AS user_name, u.avatar_url,
         cm.body AS last_message, cm.created_at AS last_at,
         (SELECT COUNT(*) FROM chat_messages
           WHERE hotel_id = $1 AND user_id = cm.user_id
             AND sender_role = 'customer' AND read_at IS NULL)::int AS unread
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.hotel_id = $1
         AND u.provider != 'system'
         AND cm.sender_role IN ('customer', 'admin')
       ORDER BY cm.user_id, cm.created_at DESC`,
      [req.hotel.id]
    )

    res.json([systemThread, ...humans.rows.map((row) => ({ ...row, is_system: false }))])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

router.get('/:hotelSlug/threads', listThreads)
router.get('/:hotelSlug/admin/threads', listThreads)

router.get('/:hotelSlug/admin/messages/:userId', async (req, res) => {
  if (!(await isAdminForHotel(req))) return res.status(403).json({ error: 'Forbidden' })
  try {
    const pool = getPool()
    const userId = req.params.userId
    const viewingSystem = await isSystemChatUser(pool, req.hotel.id, userId)
    const roleFilter = viewingSystem
      ? ` AND sender_role = 'system'`
      : ` AND sender_role IN ('customer', 'admin')`
    const result = await pool.query(
      buildLatestMessagesQuery({
        whereClause: `hotel_id = $1 AND user_id = $2${roleFilter}`,
      }),
      [req.hotel.id, userId]
    )
    await pool.query(
      `UPDATE chat_messages SET read_at = NOW()
       WHERE hotel_id = $1 AND user_id = $2
         AND sender_role = $3 AND read_at IS NULL`,
      [req.hotel.id, userId, viewingSystem ? 'system' : 'customer']
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── รูปภาพในแชท ───────────────────────────────────────────────────────────────

router.get('/:hotelSlug/images/:filename', async (req, res) => {
  try {
    const pool = getPool()
    const msgRes = await pool.query(
      `SELECT user_id FROM chat_messages WHERE hotel_id = $1 AND image_url = $2 LIMIT 1`,
      [req.hotel.id, req.params.filename]
    )
    if (!msgRes.rows[0]) return res.status(404).end()
    const admin = await isAdminForHotel(req)
    if (!sameUserId(msgRes.rows[0].user_id, req.user.id) && !admin) {
      return res.status(403).end()
    }
    const file = await readChatImageFile(req.hotel.id, req.params.filename)
    if (!file) return res.status(404).end()
    res.set('Content-Type', MIME_EXT[file.ext] || 'application/octet-stream')
    res.set('Cache-Control', `private, max-age=${getChatImageCacheMaxAge()}`)
    res.send(file.buffer)
  } catch (err) {
    res.status(404).end()
  }
})

module.exports = router
