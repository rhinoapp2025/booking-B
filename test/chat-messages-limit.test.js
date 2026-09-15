const test = require('node:test')
const assert = require('node:assert/strict')
const { CHAT_MESSAGE_LOAD_LIMIT, buildLatestMessagesQuery } = require('../src/utils/chatMessages')

test('chat loads latest messages capped at 500', () => {
  assert.equal(CHAT_MESSAGE_LOAD_LIMIT, 500)
  const sql = buildLatestMessagesQuery({
    whereClause: 'shop_id = $1 AND user_id = $2',
  })
  assert.match(sql, /ORDER BY created_at DESC/)
  assert.match(sql, /LIMIT 500/)
  assert.match(sql, /ORDER BY cm\.created_at ASC\s*$/)
})
