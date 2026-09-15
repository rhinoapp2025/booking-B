const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeHex,
  normalizeTheme,
  sanitizeThemeSettings,
  DEFAULT_THEME,
} = require('../src/utils/hotelTheme')

test('normalizeHex expands short hex and uppercases', () => {
  assert.equal(normalizeHex('#c48', DEFAULT_THEME.ui_color_primary), '#CC4488')
  assert.equal(normalizeHex('#c4847a', DEFAULT_THEME.ui_color_primary), '#C4847A')
})

test('normalizeHex falls back on invalid values', () => {
  assert.equal(normalizeHex('red', DEFAULT_THEME.ui_color_primary), DEFAULT_THEME.ui_color_primary)
  assert.equal(normalizeHex('', DEFAULT_THEME.ui_color_text), DEFAULT_THEME.ui_color_text)
})

test('normalizeTheme fills defaults and sanitizes font keys', () => {
  assert.deepEqual(normalizeTheme({}), DEFAULT_THEME)
  assert.equal(normalizeTheme({ ui_font_family: 'comic-sans' }).ui_font_family, 'noto')
  assert.equal(normalizeTheme({ ui_font_size: 'huge' }).ui_font_size, 'md')
  assert.equal(normalizeTheme({ ui_font_family: 'Kanit', ui_font_size: 'LG' }).ui_font_family, 'kanit')
  assert.equal(normalizeTheme({ ui_color_background: '#111' }).ui_color_background, '#111111')
})

test('sanitizeThemeSettings only rewrites present keys', () => {
  const patch = sanitizeThemeSettings({
    ui_color_primary: '#1a56db',
    deposit_percent: '30',
  })
  assert.equal(patch.ui_color_primary, '#1A56DB')
  assert.equal(patch.deposit_percent, '30')
  assert.equal(patch.ui_font_family, undefined)
})
