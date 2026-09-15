const test = require('node:test')
const assert = require('node:assert/strict')

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isValidShopSlug(slug) {
  const s = String(slug || '').trim().toLowerCase()
  if (!s || !SLUG_RE.test(s)) return false
  if (s === 'default') return false
  return true
}

test('shop slug regex accepts valid slugs', () => {
  assert.equal(isValidShopSlug('nail-studio'), true)
  assert.equal(isValidShopSlug('shop2'), true)
})

test('shop slug regex rejects invalid slugs', () => {
  assert.equal(isValidShopSlug('default'), false)
  assert.equal(isValidShopSlug('Bad Slug'), false)
  assert.equal(isValidShopSlug('a--b'), false)
  assert.equal(isValidShopSlug(''), false)
})

test('shop slug regex lowercases before validation', () => {
  assert.equal(isValidShopSlug('Nail-Studio'), true)
})
