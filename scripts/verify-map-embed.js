/**
 * ทดสอบการแปลงลิงก์ Google Maps → embed URL
 * รัน: node scripts/verify-map-embed.js
 */
const {
  parseGoogleMapsLocation,
  resolveShopMapEmbedUrlSync,
  resolveShopMapEmbedUrl,
  isShortGoogleMapsUrl,
} = require('../src/utils/googleMapEmbed')

const SAMPLES = [
  {
    name: 'ลิงก์ place (@lat,lng)',
    url: 'https://www.google.com/maps/place/Nail+Salon/@13.7307,100.5418,17z/data=!3m1!4b1',
  },
  {
    name: 'ลิงก์ place (!3d!4d pin)',
    url: 'https://www.google.com/maps/place/Test/@13.7000,100.5000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d13.756331!4d100.501765',
  },
  {
    name: 'ลิงก์ q= พิกัด',
    url: 'https://maps.google.com/maps?q=13.7563,100.5018',
  },
  {
    name: 'ลิงก์ api=1 query',
    url: 'https://www.google.com/maps/search/?api=1&query=Central+World+Bangkok',
  },
  {
    name: 'embed อย่างเป็นทางการ',
    url: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3875.5',
  },
]

console.log('=== ทดสอบ parse + sync resolve ===\n')
let pass = 0
let fail = 0

for (const sample of SAMPLES) {
  const loc = parseGoogleMapsLocation(sample.url)
  const embed = resolveShopMapEmbedUrlSync(sample.url, '')
  const ok = !!embed
  console.log(`${ok ? '✓' : '✗'} ${sample.name}`)
  console.log(`  input:  ${sample.url.slice(0, 80)}${sample.url.length > 80 ? '...' : ''}`)
  console.log(`  parsed: ${JSON.stringify(loc)}`)
  console.log(`  embed:  ${embed || '(ว่าง — แปลงไม่ได้)'}`)
  console.log()
  if (ok) pass += 1
  else fail += 1
}

async function testShortUrl() {
  console.log('=== ทดสอบลิงก์สั้น maps.app.goo.gl (ต้องมีเน็ต) ===\n')
  const shortUrl = process.argv[2] || ''
  if (!shortUrl) {
    console.log('ข้าม — ใส่ลิงก์สั้นทดสอบ: node scripts/verify-map-embed.js "https://maps.app.goo.gl/xxx"\n')
    return
  }
  if (!isShortGoogleMapsUrl(shortUrl)) {
    console.log('✗ ไม่ใช่ลิงก์สั้น Google Maps\n')
    return
  }
  const embed = await resolveShopMapEmbedUrl(shortUrl, '')
  console.log(`input:  ${shortUrl}`)
  console.log(`embed:  ${embed || '(ว่าง — แปลงไม่ได้)'}`)
  console.log(embed ? '✓ แปลงได้' : '✗ แปลงไม่ได้')
  console.log()
}

async function testEmbedReachable(embedUrl) {
  if (!embedUrl) return
  try {
    const res = await fetch(embedUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NailBooking/1.0)' },
    })
    const ct = res.headers.get('content-type') || ''
    const ok = res.ok && (ct.includes('text/html') || ct.includes('application/json'))
    console.log(`HTTP ${res.status} ${ok ? '✓ โหลดได้' : '✗ อาจถูกบล็อก'} — ${embedUrl.slice(0, 70)}...`)
  } catch (err) {
    console.log(`✗ fetch ล้มเหลว: ${err.message}`)
  }
}

testShortUrl().then(async () => {
  const testEmbed = resolveShopMapEmbedUrlSync(SAMPLES[0].url, '')
  console.log('=== ทดสอบ HTTP ว่า embed โหลดได้ (ตัวอย่าง place URL) ===\n')
  await testEmbedReachable(testEmbed)
  console.log()
  console.log(`สรุป sync: ผ่าน ${pass}/${SAMPLES.length}, ล้มเหลว ${fail}/${SAMPLES.length}`)
})
