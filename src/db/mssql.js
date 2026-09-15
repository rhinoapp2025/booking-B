/**
 * mssql.js
 * MSSQL connection สำหรับเชื่อมต่อฐานข้อมูล Kiosk (SQL Server)
 * ใช้งานเฉพาะส่วน kiosk vacant rooms ภายใน hotel booking system
 */

const sql = require('mssql')

const MSSQL_BASE = {
  user:     process.env.MSSQL_USER     || 'sa',
  password: process.env.MSSQL_PASSWORD || '',
  server:   process.env.MSSQL_SERVER   || '127.0.0.1',
  port:     Number(process.env.MSSQL_PORT) || 1433,
  options: {
    encrypt:                false,
    trustServerCertificate: true,
  },
}

/**
 * เชื่อมต่อ MSSQL กับ database ที่ระบุ
 * @param {string} dbName - ชื่อ database
 * @returns {Promise<sql.ConnectionPool>}
 */
async function connectDynamicDB(dbName) {
  const pool = new sql.ConnectionPool({ ...MSSQL_BASE, database: dbName })
  await pool.connect()
  return pool
}

module.exports = { sql, connectDynamicDB }
