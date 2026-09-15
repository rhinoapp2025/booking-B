const passport         = require('passport')
const GoogleStrategy   = require('passport-google-oauth20').Strategy
const FacebookStrategy = require('passport-facebook').Strategy
const LineStrategy     = require('passport-line').Strategy
const jwt              = require('jsonwebtoken')
const { getPool } = require('../db/pool')

function hasEnv(...keys) {
  return keys.every((key) => Boolean(process.env[key]))
}

async function findOrCreateUser({ provider, providerId, name, email, avatarUrl }) {
  const pool = getPool()

  const found = await pool.query(
    `SELECT * FROM users WHERE provider = $1 AND provider_id = $2`,
    [provider, providerId]
  )

  if (found.rows.length > 0) return found.rows[0]

  const created = await pool.query(
    `INSERT INTO users (name, email, avatar_url, provider, provider_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, email || `${providerId}@${provider}.local`, avatarUrl || null, provider, providerId]
  )

  return created.rows[0]
}

if (hasEnv('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL')) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await findOrCreateUser({
        provider:   'google',
        providerId: profile.id,
        name:       profile.displayName,
        email:      profile.emails?.[0]?.value,
        avatarUrl:  profile.photos?.[0]?.value,
      })
      done(null, user)
    } catch (err) { done(err) }
  }))
}

if (hasEnv('FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_CALLBACK_URL')) {
  passport.use(new FacebookStrategy({
    clientID:      process.env.FACEBOOK_APP_ID,
    clientSecret:  process.env.FACEBOOK_APP_SECRET,
    callbackURL:   process.env.FACEBOOK_CALLBACK_URL,
    profileFields: ['id', 'displayName', 'emails', 'photos'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await findOrCreateUser({
        provider:   'facebook',
        providerId: profile.id,
        name:       profile.displayName,
        email:      profile.emails?.[0]?.value,
        avatarUrl:  profile.photos?.[0]?.value,
      })
      done(null, user)
    } catch (err) { done(err) }
  }))
}

if (hasEnv('LINE_CLIENT_ID', 'LINE_CLIENT_SECRET', 'LINE_CALLBACK_URL')) {
  passport.use(new LineStrategy({
    channelID:     process.env.LINE_CLIENT_ID,
    channelSecret: process.env.LINE_CLIENT_SECRET,
    callbackURL:   process.env.LINE_CALLBACK_URL,
    scope: ['profile', 'openid', 'email'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const user = await findOrCreateUser({
        provider:   'line',
        providerId: profile.id,
        name:       profile.displayName,
        email:      profile.emails?.[0]?.value,
        avatarUrl:  profile.pictureUrl,
      })
      done(null, user)
    } catch (err) { done(err) }
  }))
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, is_admin: Boolean(user.is_admin), is_super_admin: Boolean(user.is_super_admin) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '365d' }
  )
}

module.exports = { passport, signToken }
