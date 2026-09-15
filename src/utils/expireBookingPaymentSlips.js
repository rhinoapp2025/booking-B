const { deleteBookingPaymentSlip } = require('./bookingPaymentSlips')

const DEFAULT_RETENTION_DAYS = 90

async function expireBookingPaymentSlips(poolOrClient) {
  const hotels = await poolOrClient.query(`SELECT id FROM hotels`)
  let deleted = 0

  for (const hotel of hotels.rows) {
    const result = await poolOrClient.query(
      `SELECT id, slip_filename FROM booking_payment_slips
       WHERE hotel_id = $1
         AND created_at < NOW() - ($2::int * INTERVAL '1 day')`,
      [hotel.id, DEFAULT_RETENTION_DAYS]
    )
    for (const row of result.rows) {
      await deleteBookingPaymentSlip(row.slip_filename).catch(() => null)
      await poolOrClient.query(`DELETE FROM booking_payment_slips WHERE id = $1`, [row.id])
      deleted++
    }
  }

  return deleted
}

module.exports = { expireBookingPaymentSlips }
