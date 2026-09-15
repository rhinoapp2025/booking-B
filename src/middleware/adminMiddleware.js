function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'สิทธิ์แอดมินเท่านั้น' })
  }
  next()
}

module.exports = adminMiddleware
