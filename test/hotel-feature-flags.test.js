const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildResolvedFeatures,
  buildDefaultTemplateFromMap,
} = require('../src/utils/hotelFeatureFlags')
const {
  ALL_FEATURE_KEYS,
  catalogDefaultEnabled,
  featureSettingKey,
  featureDefaultSettingKey,
} = require('../src/constants/hotelFeatureCatalog')

test('catalog defaults are enabled unless specified', () => {
  assert.equal(catalogDefaultEnabled('nav_reviews'), true)
  assert.equal(catalogDefaultEnabled('tab_bookings'), true)
})

test('locked tab_bookings stays enabled in resolved features', () => {
  const features = buildResolvedFeatures(
    { [featureSettingKey('tab_bookings')]: '0' },
    {}
  )
  assert.equal(features.tab_bookings, true)
})

test('hotel override disables feature', () => {
  const features = buildResolvedFeatures(
    { [featureSettingKey('nav_chat')]: '0' },
    {}
  )
  assert.equal(features.nav_chat, false)
  assert.equal(features.nav_reviews, true)
})

test('template applies when hotel has no override', () => {
  const templateEntries = {
    [featureDefaultSettingKey('nav_reviews')]: '0',
  }
  const features = buildResolvedFeatures({}, templateEntries)
  assert.equal(features.nav_reviews, false)
})

test('buildDefaultTemplateFromMap reads default keys', () => {
  const map = {
    [featureDefaultSettingKey('feat_coupons')]: '0',
  }
  const template = buildDefaultTemplateFromMap(map)
  assert.equal(template.feat_coupons, false)
  assert.equal(template.nav_chat, true)
})

test('all catalog keys resolve', () => {
  const features = buildResolvedFeatures({}, {})
  assert.equal(Object.keys(features).length, ALL_FEATURE_KEYS.length)
})
