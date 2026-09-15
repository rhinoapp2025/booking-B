/**
 * CLI wrapper for admin API smoke tests.
 * Usage: node scripts/admin-smoke-test.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { spawnSync } = require('child_process')
const path = require('path')

const result = spawnSync(process.execPath, ['--test', path.join(__dirname, '..', 'test', 'admin-api.test.js')], {
  stdio: 'inherit',
  env: process.env,
})

process.exit(result.status ?? 1)
