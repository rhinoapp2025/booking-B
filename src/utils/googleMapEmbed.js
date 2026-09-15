function hasHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim())
}

function isGoogleMapsEmbedUrl(value) {
  const url = String(value ?? '').trim()
  if (!hasHttpUrl(url)) return false
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    return (
      (host === 'google.com' || host.endsWith('.google.com'))
      && u.pathname.startsWith('/maps/embed')
    )
  } catch {
    return false
  }
}

function isShortGoogleMapsUrl(value) {
  const url = String(value ?? '').trim()
  if (!hasHttpUrl(url)) return false
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host === 'goo.gl' || host === 'g.co' || host === 'maps.app.goo.gl'
  } catch {
    return false
  }
}

function extractPbParam(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return ''

  if (isGoogleMapsEmbedUrl(raw)) {
    try {
      return new URL(raw).searchParams.get('pb') || ''
    } catch {
      return ''
    }
  }

  try {
    const pb = new URL(raw).searchParams.get('pb')
    if (pb) return pb
  } catch {
    // fall through
  }

  const match = raw.match(/[?&]pb=([^&]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

function buildEmbedFromPb(pb) {
  const value = String(pb ?? '').trim()
  if (!value) return ''
  return `https://www.google.com/maps/embed?pb=${encodeURIComponent(value)}`
}

function parseCoordinatePair(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const match = raw.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/)
  if (!match) return null
  return { lat: match[1], lng: match[2] }
}

function parseGoogleMapsLocation(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return null

  const pinMatch = raw.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
  if (pinMatch) {
    return { lat: pinMatch[1], lng: pinMatch[2] }
  }

  const atMatch = raw.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (atMatch) {
    return { lat: atMatch[1], lng: atMatch[2] }
  }

  try {
    const u = new URL(raw)
    const searchPathMatch = u.pathname.match(/\/maps\/search\/(-?\d+(?:\.\d+)?),\+?(-?\d+(?:\.\d+)?)/)
    if (searchPathMatch) {
      return { lat: searchPathMatch[1], lng: searchPathMatch[2] }
    }
    const q = u.searchParams.get('q') || u.searchParams.get('query')
    if (q) {
      const coords = parseCoordinatePair(q)
      if (coords) return coords
      return { query: q }
    }

    const ll = u.searchParams.get('ll')
    if (ll) {
      const coords = parseCoordinatePair(ll)
      if (coords) return coords
    }

    const placeId = u.searchParams.get('place_id')
    if (placeId) return { placeId }
  } catch {
    // fall through
  }

  const placeMatch = raw.match(/(ChIJ[\w-]+)/)
  if (placeMatch) return { placeId: placeMatch[1] }

  return null
}

function buildEmbedFromLocation(location, apiKey = '') {
  if (!location) return ''

  const key = String(apiKey ?? '').trim()
  if (key) {
    let q = ''
    if (location.placeId) q = `place_id:${location.placeId}`
    else if (location.lat && location.lng) q = `${location.lat},${location.lng}`
    else if (location.query) q = location.query
    if (q) {
      return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&language=th`
    }
  }

  if (location.lat && location.lng) {
    const q = `${location.lat},${location.lng}`
    return `https://maps.google.com/maps?q=${encodeURIComponent(q)}&hl=th&z=16&output=embed`
  }
  if (location.query) {
    return `https://maps.google.com/maps?q=${encodeURIComponent(location.query)}&hl=th&z=16&output=embed`
  }
  if (location.placeId) {
    return `https://maps.google.com/maps?q=${encodeURIComponent(`place_id:${location.placeId}`)}&hl=th&z=16&output=embed`
  }

  return ''
}

function resolveHotelMapEmbedUrlSync(mapUrl, embedUrl, options = {}) {
  const apiKey = options.apiKey ?? process.env.GOOGLE_MAPS_EMBED_API_KEY ?? ''

  const embed = String(embedUrl ?? '').trim()
  if (isGoogleMapsEmbedUrl(embed)) return embed

  const embedPb = extractPbParam(embed)
  if (embedPb) return buildEmbedFromPb(embedPb)

  const map = String(mapUrl ?? '').trim()
  if (!hasHttpUrl(map)) return ''
  if (isGoogleMapsEmbedUrl(map)) return map

  const mapPb = extractPbParam(map)
  if (mapPb) return buildEmbedFromPb(mapPb)

  const location = parseGoogleMapsLocation(map)
  return buildEmbedFromLocation(location, apiKey)
}

function createMapEmbedDebug() {
  return { steps: [], startedAt: new Date().toISOString() }
}

function pushMapEmbedDebug(debug, step, data = {}) {
  if (!debug) return
  debug.steps.push({ step, ...data })
}

function logMapEmbed(step, data = {}) {
  try {
    console.log('[map-embed]', step, JSON.stringify(data))
  } catch {
    console.log('[map-embed]', step)
  }
}

function summarizeMapUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return ''
  if (raw.length <= 120) return raw
  return `${raw.slice(0, 117)}...`
}

function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

const RESOLVE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
}

async function resolveGoogleMapsShareUrl(url, debug = null) {
  const raw = String(url ?? '').trim()
  if (!raw || !isShortGoogleMapsUrl(raw)) {
    pushMapEmbedDebug(debug, 'skip_expand', { reason: 'not_short_url', url: summarizeMapUrl(raw) })
    return raw
  }

  logMapEmbed('expand_start', { url: summarizeMapUrl(raw) })
  pushMapEmbedDebug(debug, 'expand_start', { url: raw })

  let current = raw
  for (let hop = 0; hop < 8; hop += 1) {
    try {
      const res = await fetchWithTimeout(current, {
        method: 'GET',
        redirect: 'manual',
        headers: RESOLVE_HEADERS,
      })

      pushMapEmbedDebug(debug, 'expand_hop', {
        hop,
        status: res.status,
        current: summarizeMapUrl(current),
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) {
          pushMapEmbedDebug(debug, 'expand_stop', { reason: 'redirect_without_location', hop })
          break
        }
        current = new URL(location, current).href
        if (!isShortGoogleMapsUrl(current)) {
          logMapEmbed('expand_ok_manual', { expanded: summarizeMapUrl(current), hops: hop + 1 })
          pushMapEmbedDebug(debug, 'expand_ok', { method: 'manual', expanded: current, hops: hop + 1 })
          return current
        }
        continue
      }

      if (res.url && !isShortGoogleMapsUrl(res.url)) {
        logMapEmbed('expand_ok_res_url', { expanded: summarizeMapUrl(res.url), hops: hop + 1 })
        pushMapEmbedDebug(debug, 'expand_ok', { method: 'res.url', expanded: res.url, hops: hop + 1 })
        return res.url
      }
      if (!isShortGoogleMapsUrl(current)) {
        logMapEmbed('expand_ok_current', { expanded: summarizeMapUrl(current), hops: hop + 1 })
        pushMapEmbedDebug(debug, 'expand_ok', { method: 'current', expanded: current, hops: hop + 1 })
        return current
      }
      pushMapEmbedDebug(debug, 'expand_stop', { reason: 'still_short_after_hop', hop, status: res.status })
      break
    } catch (err) {
      logMapEmbed('expand_manual_error', { hop, error: err.message })
      pushMapEmbedDebug(debug, 'expand_error', { method: 'manual', hop, error: err.message })
      break
    }
  }

  try {
    const res = await fetchWithTimeout(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: RESOLVE_HEADERS,
    })
    if (res.url && !isShortGoogleMapsUrl(res.url)) {
      logMapEmbed('expand_ok_follow', { expanded: summarizeMapUrl(res.url) })
      pushMapEmbedDebug(debug, 'expand_ok', { method: 'follow', expanded: res.url })
      return res.url
    }
    pushMapEmbedDebug(debug, 'expand_follow_no_change', {
      res_url: summarizeMapUrl(res.url || ''),
      status: res.status,
    })
  } catch (err) {
    logMapEmbed('expand_follow_error', { error: err.message })
    pushMapEmbedDebug(debug, 'expand_error', { method: 'follow', error: err.message })
  }

  logMapEmbed('expand_failed', { final: summarizeMapUrl(current) })
  pushMapEmbedDebug(debug, 'expand_failed', { final: current })
  return current
}

async function resolveHotelMapEmbedUrlDetailed(mapUrl, embedUrl, options = {}) {
  const debug = options.debug || createMapEmbedDebug()
  const inputMap = String(mapUrl ?? '').trim()
  const inputEmbed = String(embedUrl ?? '').trim()

  pushMapEmbedDebug(debug, 'input', {
    map_url: summarizeMapUrl(inputMap),
    embed_url: summarizeMapUrl(inputEmbed),
    short_link: isShortGoogleMapsUrl(inputMap),
  })
  logMapEmbed('resolve_start', {
    map_url: summarizeMapUrl(inputMap),
    short_link: isShortGoogleMapsUrl(inputMap),
  })

  let map = inputMap

  if (hasHttpUrl(map)) {
    if (isShortGoogleMapsUrl(map)) {
      map = await resolveGoogleMapsShareUrl(map, debug)
    }

    const location = parseGoogleMapsLocation(map)
    pushMapEmbedDebug(debug, 'parsed_location', {
      expanded: summarizeMapUrl(map),
      location,
    })

    const fromMap = resolveHotelMapEmbedUrlSync(map, '', options)
    if (fromMap) {
      logMapEmbed('resolve_ok_from_map', { embed: summarizeMapUrl(fromMap) })
      pushMapEmbedDebug(debug, 'resolve_ok', { source: 'map_url', embed_url: fromMap })
      return { embed: fromMap, debug }
    }

    pushMapEmbedDebug(debug, 'resolve_map_failed', {
      expanded: summarizeMapUrl(map),
      still_short: isShortGoogleMapsUrl(map),
    })
  } else {
    pushMapEmbedDebug(debug, 'no_map_url', {})
  }

  if (isGoogleMapsEmbedUrl(inputEmbed)) {
    pushMapEmbedDebug(debug, 'resolve_ok', { source: 'stored_embed', embed_url: inputEmbed })
    return { embed: inputEmbed, debug }
  }

  const embedPb = extractPbParam(inputEmbed)
  if (embedPb) {
    const fromPb = buildEmbedFromPb(embedPb)
    pushMapEmbedDebug(debug, 'resolve_ok', { source: 'stored_embed_pb', embed_url: fromPb })
    return { embed: fromPb, debug }
  }

  logMapEmbed('resolve_failed', {
    map_url: summarizeMapUrl(inputMap),
    expanded: summarizeMapUrl(map),
  })
  pushMapEmbedDebug(debug, 'resolve_failed', {
    map_url: inputMap,
    expanded: map,
  })
  return { embed: '', debug }
}

async function resolveHotelMapEmbedUrl(mapUrl, embedUrl, options = {}) {
  const { embed } = await resolveHotelMapEmbedUrlDetailed(mapUrl, embedUrl, options)
  return embed
}

module.exports = {
  hasHttpUrl,
  isGoogleMapsEmbedUrl,
  isShortGoogleMapsUrl,
  extractPbParam,
  parseGoogleMapsLocation,
  buildEmbedFromLocation,
  createMapEmbedDebug,
  resolveGoogleMapsShareUrl,
  resolveHotelMapEmbedUrlSync,
  resolveHotelMapEmbedUrl,
  resolveHotelMapEmbedUrlDetailed,
}
