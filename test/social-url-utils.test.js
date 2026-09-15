const test = require('node:test')
const assert = require('node:assert/strict')
const { extractInstagramShortcode } = require('../src/utils/instagramUrl')
const {
  extractTikTokMediaId,
  normalizeTikTokPageUrl,
} = require('../src/utils/tiktokUrl')

test('extractInstagramShortcode supports post and reel URLs', () => {
  assert.deepEqual(
    extractInstagramShortcode('https://www.instagram.com/p/ABC123_/'),
    { shortcode: 'ABC123_', type: 'p' }
  )
  assert.deepEqual(
    extractInstagramShortcode('https://www.instagram.com/reel/XYZ789/'),
    { shortcode: 'XYZ789', type: 'reel' }
  )
  assert.equal(extractInstagramShortcode('https://example.com'), null)
})

test('extractTikTokMediaId from video and photo URLs', () => {
  assert.equal(
    extractTikTokMediaId('https://www.tiktok.com/@user/video/7123456789012345678'),
    '7123456789012345678'
  )
  assert.equal(
    extractTikTokMediaId('https://www.tiktok.com/@user/photo/7999999999999999999'),
    '7999999999999999999'
  )
  assert.equal(extractTikTokMediaId('https://example.com'), null)
})

test('normalizeTikTokPageUrl strips query and hash', () => {
  assert.equal(
    normalizeTikTokPageUrl('https://www.tiktok.com/@u/video/1?is_from_webapp=1#tag'),
    'https://www.tiktok.com/@u/video/1'
  )
})
