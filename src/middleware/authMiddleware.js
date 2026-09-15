const jwt = require('jsonwebtoken')

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  let token = null
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1]
  } else if (req.query?.token) {
    token = String(req.query.token)
  }

  if (!token) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' })
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Token ไม่ถูกต้องหรือหมดอายุ' })
  }
}

module.exports = authMiddleware
