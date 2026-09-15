const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseGoogleMapsLocation,
  resolveShopMapEmbedUrlSync,
  isShortGoogleMapsUrl,
} = require('../src/utils/googleMapEmbed')

test('parseGoogleMapsLocation reads @ coordinates from place URL', () => {
  assert.deepEqual(
    parseGoogleMapsLocation('https://www.google.com/maps/place/Nail/@13.7307,100.5418,17z/data=!3m1!4b1'),
    { lat: '13.7307', lng: '100.5418' }
  )
})

test('parseGoogleMapsLocation prefers !3d!4d pin over map center', () => {
  assert.deepEqual(
    parseGoogleMapsLocation(
      'https://www.google.com/maps/place/Test/@13.7000,100.5000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d13.756331!4d100.501765'
    ),
    { lat: '13.756331', lng: '100.501765' }
  )
})

test('parseGoogleMapsLocation reads q= coordinates and address', () => {
  assert.deepEqual(
    parseGoogleMapsLocation('https://maps.google.com/maps?q=13.7563,100.5018'),
    { lat: '13.7563', lng: '100.5018' }
  )
  assert.deepEqual(
    parseGoogleMapsLocation('https://www.google.com/maps/search/?api=1&query=Nail+Studio+Bangkok'),
    { query: 'Nail Studio Bangkok' }
  )
})

test('resolveShopMapEmbedUrlSync builds embed from share link', () => {
  const embed = resolveShopMapEmbedUrlSync(
    'https://www.google.com/maps/place/Test/@13.7307,100.5418,17z',
    ''
  )
  assert.match(embed, /^https:\/\/www\.google\.com\/maps\?q=/)
  assert.match(embed, /output=embed/)
})

test('resolveShopMapEmbedUrlSync keeps official embed URL', () => {
  const official = 'https://www.google.com/maps/embed?pb=!1m18!1m12'
  assert.equal(resolveShopMapEmbedUrlSync('', official), official)
})

test('parseGoogleMapsLocation reads /maps/search/lat,+lng from mobile shortlink', () => {
  assert.deepEqual(
    parseGoogleMapsLocation('https://www.google.com/maps/search/59.916239,+10.789837?entry=tts'),
    { lat: '59.916239', lng: '10.789837' }
  )
})

test('resolveShopMapEmbedUrl resolves maps.app.goo.gl after redirect', async () => {
  const { resolveShopMapEmbedUrl } = require('../src/utils/googleMapEmbed')
  const embed = await resolveShopMapEmbedUrl('https://maps.app.goo.gl/KmEWjc5T2jB24hw16', '')
  assert.match(embed, /59\.916239/)
  assert.match(embed, /10\.789837/)
  assert.match(embed, /output=embed/)
})
