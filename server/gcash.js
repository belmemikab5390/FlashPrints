/**
 * server/gcash.js — GCash Merchant API integration
 * Apply for merchant account at: https://developer.globelabs.com.ph
 */
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const BASE_URL      = process.env.GCASH_API_URL     || 'https://devapi.globelabs.com.ph';
const MERCHANT_ID   = process.env.GCASH_MERCHANT_ID  || 'SANDBOX_MERCHANT';
const CLIENT_ID     = process.env.GCASH_CLIENT_ID    || 'SANDBOX_CLIENT';
const CLIENT_SECRET = process.env.GCASH_CLIENT_SECRET|| 'SANDBOX_SECRET';

/* in-memory store — use Redis in multi-booth production */
const paymentStore = new Map();

async function createPaymentQR({ amount, sessionId, booth }) {
  const referenceId = `FP-${booth.id}-${Date.now()}`;
  paymentStore.set(referenceId, { status: 'PENDING', amount, sessionId });

  if (process.env.GCASH_ENV !== 'production') {
    console.log(`[GCASH SANDBOX] QR: ${referenceId} · PHP ${amount}`);
    return {
      ok: true, referenceId, amount,
      qrCodeData: `https://sandbox.gcash.com/pay?ref=${referenceId}&amt=${amount}`,
      expiresAt:  Date.now() + 600000,
      sandboxMode: true,
    };
  }

  try {
    const requestId = uuidv4();
    const res = await axios.post(`${BASE_URL}/payment/v1/charge`, {
      amount:      { currency: 'PHP', value: String(amount * 100) },
      description: `Flash & Prints Booth #${booth.id}`,
      referenceId, requestId, merchantId: MERCHANT_ID,
      returnUrl: `http://localhost:${process.env.SERVER_PORT||3000}/gcash/callback`,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'X-Request-ID': requestId,
      },
    });
    return { ok: true, referenceId, amount, qrCodeData: res.data.qrCode, expiresAt: Date.now() + 600000 };
  } catch (e) {
    console.error('[GCASH] create error:', e.response?.data || e.message);
    throw new Error(e.response?.data?.message || 'GCash QR creation failed');
  }
}

async function checkPaymentStatus(referenceId) {
  const local = paymentStore.get(referenceId);
  if (local?.status === 'PAID') return { ok: true, status: 'PAID', ...local };
  if (process.env.GCASH_ENV !== 'production') return { ok: true, status: local?.status || 'PENDING' };

  try {
    const res = await axios.get(`${BASE_URL}/payment/v1/charge/${referenceId}`, {
      headers: { 'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}` },
    });
    const status = res.data.status === 'CAPTURED' ? 'PAID' : res.data.status;
    if (status === 'PAID') paymentStore.set(referenceId, { ...local, status: 'PAID' });
    return { ok: true, status };
  } catch (e) {
    return { ok: false, status: 'ERROR' };
  }
}

function confirmPayment(referenceId, data) {
  paymentStore.set(referenceId, { ...paymentStore.get(referenceId), status: 'PAID', ...data });
}

module.exports = { createPaymentQR, checkPaymentStatus, confirmPayment };
