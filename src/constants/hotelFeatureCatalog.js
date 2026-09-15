/** Feature groups controllable per hotel branch (super admin / default). */
const HOTEL_FEATURE_CATALOG = [
  {
    key: 'customer_nav',
    label: 'เมนูลูกค้า',
    icon: 'ti-users',
    hint: 'เปิด/ปิดรายการในแถบเมนูล่างของแขก',
    items: [
      { key: 'nav_reviews', label: 'รีวิว', default: true },
      { key: 'nav_info', label: 'ที่ตั้ง', default: true },
      { key: 'nav_chat', label: 'แชท', default: true },
    ],
  },
  {
    key: 'admin_tabs',
    label: 'แท็บแอดมิน',
    icon: 'ti-layout-navbar',
    hint: 'เปิด/ปิดแท็บในหน้าแอดมินของสาขา',
    items: [
      { key: 'tab_dashboard', label: 'ภาพรวม', default: true, locked: true },
      { key: 'tab_bookings', label: 'การจอง', default: true, locked: true },
      { key: 'tab_rooms', label: 'ห้องพัก', default: true },
      { key: 'tab_kiosk', label: 'PMS', default: true },
      { key: 'tab_settings', label: 'ตั้งค่าโรงแรม', default: true },
    ],
  },
  {
    key: 'guest_features',
    label: 'ฟังก์ชันจอง / ชำระ',
    icon: 'ti-calendar-check',
    hint: 'เปิด/ปิดความสามารถที่แขกใช้ตอนจองและชำระมัดจำ',
    items: [
      { key: 'feat_payment_slip', label: 'มัดจำ / อัปโหลดสลิป', default: true },
    ],
  },
  {
    key: 'coupon_features',
    label: 'คูปอง / แต้ม',
    icon: 'ti-ticket',
    hint: 'ปิดแล้วจะซ่อนตั้งค่าคูปองในหน้าตั้งค่าโรงแรม และไม่ให้แขกแลกคูปอง',
    items: [
      { key: 'feat_coupons', label: 'สะสมแต้ม / คูปอง', default: true },
    ],
  },
]

const FEATURE_ITEM_MAP = Object.fromEntries(
  HOTEL_FEATURE_CATALOG.flatMap((group) =>
    group.items.map((item) => [item.key, { ...item, groupKey: group.key, groupLabel: group.label }])
  )
)

const ALL_FEATURE_KEYS = Object.keys(FEATURE_ITEM_MAP)

function featureSettingKey(itemKey) {
  return `feature_${itemKey}`
}

function featureDefaultSettingKey(itemKey) {
  return `feature_default_${itemKey}`
}

function catalogDefaultEnabled(itemKey) {
  const item = FEATURE_ITEM_MAP[itemKey]
  if (!item) return true
  if (item.locked) return true
  return item.default !== false
}

module.exports = {
  HOTEL_FEATURE_CATALOG,
  FEATURE_ITEM_MAP,
  ALL_FEATURE_KEYS,
  featureSettingKey,
  featureDefaultSettingKey,
  catalogDefaultEnabled,
}
