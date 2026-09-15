function parseAllowedOrigins() {
  return String(process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function matchesPattern(origin, pattern) {
  const normalizedPattern = pattern.replace(/\/$/, '')
  if (!normalizedPattern.includes('*')) {
    return origin === normalizedPattern
  }
  const re = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*/g, '[^/]*')}$`)
  return re.test(origin)
}

function isNetlifyOrigin(origin) {
  return /^https:\/\/[\w-]+(\.[\w-]+)*\.netlify\.app$/i.test(origin)
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true

  const normalized = origin.replace(/\/$/, '')
  if (allowedOrigins.some((pattern) => matchesPattern(normalized, pattern))) {
    return true
  }

  // One Netlify URL in FRONTEND_URL covers preview deploys too.
  if (allowedOrigins.some((pattern) => pattern.includes('netlify.app')) && isNetlifyOrigin(normalized)) {
    return true
  }

  return false
}

function createCorsOptions() {
  const allowedOrigins = parseAllowedOrigins()

  return {
    origin(origin, callback) {
      if (isAllowedOrigin(origin, allowedOrigins)) {
        callback(null, true)
        return
      }
      console.warn(`[cors] blocked origin: ${origin || '(none)'}`)
      callback(null, false)
    },
    credentials: true,
  }
}

module.exports = {
  parseAllowedOrigins,
  isAllowedOrigin,
  createCorsOptions,
}
