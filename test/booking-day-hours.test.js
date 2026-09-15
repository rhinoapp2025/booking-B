const test = require('node:test')
const assert = require('node:assert/strict')
const {
  windowsOverlap,
  validateDayHourPayload,
  buildFullDayHourWindows,
  computeDayHourCascadeUpdates,
} = require('../src/utils/bookingDayHours')

test('windowsOverlap detects overlapping ranges', () => {
  const a = { start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 }
  const b = { start_hour: 11, start_minute: 0, end_hour: 13, end_minute: 0 }
  const c = { start_hour: 12, start_minute: 0, end_hour: 14, end_minute: 0 }
  assert.equal(windowsOverlap(a, b), true)
  assert.equal(windowsOverlap(a, c), false)
})

test('validateDayHourPayload requires schedule_date', () => {
  const result = validateDayHourPayload(
    { start_hour: 10, end_hour: 12 },
    []
  )
  assert.equal(result.ok, false)
})

test('validateDayHourPayload rejects overlap', () => {
  const existing = [{ id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 }]
  const result = validateDayHourPayload(
    {
      schedule_date: '2026-05-01',
      start_hour: 11,
      start_minute: 0,
      end_hour: 13,
      end_minute: 0,
    },
    existing
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /ทับซ้อน/)
})

test('validateDayHourPayload accepts valid window', () => {
  const result = validateDayHourPayload(
    {
      schedule_date: '2026-05-01',
      start_hour: 14,
      start_minute: 0,
      end_hour: 16,
      end_minute: 0,
    },
    [{ id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 }]
  )
  assert.equal(result.ok, true)
  assert.equal(result.start_hour, 14)
})

test('buildFullDayHourWindows packs shop hours like dynamic mode', () => {
  const windows = buildFullDayHourWindows({ openHour: 9, lastBookingHour: 18, slotHours: 2 })
  assert.ok(windows.length >= 5)
  assert.equal(windows[0].start_hour, 9)
  assert.equal(windows[0].end_hour, 11)
})

test('computeDayHourCascadeUpdates shifts chained next window', () => {
  const windows = [
    { id: 1, start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0 },
    { id: 2, start_hour: 12, start_minute: 0, end_hour: 14, end_minute: 0 },
  ]
  const result = computeDayHourCascadeUpdates(
    windows,
    1,
    { start_hour: 10, start_minute: 0, end_hour: 13, end_minute: 0 },
    12 * 60
  )
  assert.equal(result.error, undefined)
  assert.equal(result.updates.length, 2)
  assert.equal(result.updates[1].start_hour, 13)
})
