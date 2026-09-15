const { EventEmitter } = require('events')

const emitters = new Map()

function getEmitter(hotelId) {
  const key = String(hotelId)
  if (!emitters.has(key)) {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(100)
    emitters.set(key, emitter)
  }
  return emitters.get(key)
}

function emitBookingChanged(hotelId, payload = {}) {
  if (hotelId == null) return
  getEmitter(hotelId).emit('change', {
    type:       payload.type       || 'updated',
    booking_id: payload.booking_id || null,
    at:         new Date().toISOString(),
  })
}

function subscribeBookingEvents(hotelId, listener) {
  const emitter = getEmitter(hotelId)
  emitter.on('change', listener)
  return () => emitter.off('change', listener)
}

module.exports = { emitBookingChanged, subscribeBookingEvents }
