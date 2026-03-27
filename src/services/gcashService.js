/**
 * src/services/gcashService.js
 *
 * Handles all GCash API calls from the main process.
 * Called via IPC from the renderer (payment screen).
 */

const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3001';

/**
 * Create a new GCash QR session.
 * Returns: { ref, orNum, qrDataURL, expiresIn }
 */
async function createPayment({ amount, pkg, filter }) {
  const res = await axios.post(`${BASE_URL}/api/gcash/create`, {
    amount, pkg, filter,
  });
  if (!res.data.ok) throw new Error(res.data.error || 'GCash create failed');
  return res.data;
}

/**
 * Poll payment status.
 * Returns: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED'
 */
async function checkPaymentStatus(ref) {
  const res = await axios.get(`${BASE_URL}/api/gcash/status/${ref}`);
  if (!res.data.ok) throw new Error(res.data.error);
  return res.data.status; // 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED'
}

module.exports = { createPayment, checkPaymentStatus };
