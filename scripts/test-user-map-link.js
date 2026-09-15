const b = require('../src/utils/googleMapEmbed')

const SHORT = 'https://maps.app.goo.gl/Us5xEL7Echs2Xg6N8'

function frontendResolve(mapUrl, embedUrl) {
  const map = String(mapUrl ?? '').trim()
  if (/^https?:\/\//i.test(map) && !map.includes('goo.gl')) {
    const sync = b.resolveShopMapEmbedUrlSync(map, '')
    if (sync) return { source: 'map-expanded', url: sync }
  }
  const embed = String(embedUrl ?? '').trim()
  if (embed) return { source: 'stored-embed', url: embed }
  return { source: 'none', url: '' }
}

;(async () => {
  console.log('Link:', SHORT)
  console.log()

  console.log('=== A. Admin save (backend) ===')
  const onSave = await b.resolveShopMapEmbedUrl(SHORT, '')
  const saveOk = !!onSave && onSave.includes('13.7656722')
  console.log('embed:', onSave)
  console.log(saveOk ? 'PASS' : 'FAIL')
  console.log()

  console.log('=== B. Customer page with stored embed ===')
  const display = frontendResolve(SHORT, onSave)
  const displayOk = display.url === onSave
  console.log(display)
  console.log(displayOk ? 'PASS' : 'FAIL')
  console.log()

  console.log('=== C. Customer page short link only (no embed yet) ===')
  const noEmbed = frontendResolve(SHORT, '')
  console.log(noEmbed)
  console.log(noEmbed.url === '' ? 'PASS (empty until backend resolves on load)' : 'FAIL')
  console.log()

  console.log('=== D. HTTP embed load ===')
  const res = await fetch(onSave, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const html = await res.text()
  const httpOk = res.ok && /google\.maps|initEmbed|maps\.google/i.test(html.slice(0, 10000))
  console.log('status:', res.status, httpOk ? 'PASS' : 'FAIL')
})()
