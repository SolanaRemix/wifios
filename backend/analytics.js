'use strict';

const { all, get } = require('./db');

/**
 * Return aggregated statistics for the admin dashboard.
 * @returns {Promise<object>}
 */
async function getStats() {
  const [
    totalUsers,
    activeUsers,
    expiredUsers,
    blockedUsers,
    totalRevenue,
    recentPayments,
  ] = await Promise.all([
    get('SELECT COUNT(*) AS count FROM users'),
    get("SELECT COUNT(*) AS count FROM users WHERE status = 'active'"),
    get("SELECT COUNT(*) AS count FROM users WHERE status = 'expired'"),
    get("SELECT COUNT(*) AS count FROM users WHERE status = 'blocked'"),
    get("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'confirmed'"),
    all(
      `SELECT ref, mac, amount, time_grant, created_at
       FROM payments
       WHERE status = 'confirmed'
       ORDER BY created_at DESC
       LIMIT 10`
    ),
  ]);

  const hourlyRevenue = await all(`
    SELECT
      strftime('%Y-%m-%d %H:00', created_at) AS hour,
      SUM(amount) AS revenue
    FROM payments
    WHERE status = 'confirmed'
      AND created_at >= datetime('now', '-24 hours')
    GROUP BY hour
    ORDER BY hour
  `);

  return {
    totalUsers: totalUsers.count,
    activeUsers: activeUsers.count,
    expiredUsers: expiredUsers.count,
    blockedUsers: blockedUsers.count,
    totalRevenue: totalRevenue.total,
    recentPayments,
    hourlyRevenue,
  };
}

module.exports = { getStats };
