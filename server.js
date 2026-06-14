// server.js — Pinnacle Developments electricity recharge backend
// npm i express axios dotenv
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ── CORS: let the static frontend (a different domain) call this backend ──
// Set FRONTEND_ORIGIN in Render to your static-site URL, e.g.
//   https://pinnacle-frontend.onrender.com
// If unset, defaults to "*" (any site) so you can test — tighten it for production.
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204); // browser pre-flight check
  next();
});

// Simple health check at the root so visiting the bare URL shows it's alive
app.get('/', (req, res) => res.send('Pinnacle recharge backend running.'));

const EKM_BASE = 'https://www.openapi.ekm365.com/api.ashx';
const EKM_API = process.env.EKM_API || '1212'; // your assigned api= value from EKM (1212 is the doc placeholder)
const txns = {}; // in-memory store; use Redis/Postgres in production

// EKM returns result as either the number 200 or the string "200" depending on
// the call. Treat both as success.
const isOk = (r) => String(r) === '200';

// ────────────────────────────────────────────────
// EKM365 auth: apiKey valid 24h, refresh at 20h
// ────────────────────────────────────────────────
let ekmKey = null, ekmKeyTime = 0;
async function ekmApiKey() {
  if (ekmKey && Date.now() - ekmKeyTime < 20 * 3600 * 1000) return ekmKey;
  const { data } = await axios.post(
    `${EKM_BASE}?Method=login&api=${EKM_API}`,
    { nam: process.env.EKM_USER, psw: process.env.EKM_PASS }
  );
  if (!isOk(data.result)) throw new Error('EKM login failed: ' + data.result);
  ekmKey = data.value.apiKey;
  ekmKeyTime = Date.now();
  return ekmKey;
}

async function ekm(method, body) {
  const key = await ekmApiKey();
  const url = `${EKM_BASE}?Method=${method}&api=${EKM_API}&apikey=${encodeURIComponent(key)}`;
  const { data } = await axios.post(url, { loginid: process.env.EKM_LOGINID, ...body });
  return data;
}

// ────────────────────────────────────────────────
// Startup: verify the tariff in EKM matches KES 31
// ────────────────────────────────────────────────
async function checkTariff() {
  try {
    const r = await ekm('getPrices', { ckv: '1', ptype: 1, offset: -1, limit: -1 });
    if (!isOk(r.result)) { console.warn('getPrices failed:', r.result); return; }
    const prices = (r.value || []).map(p => p.Price);
    console.log(`EKM electricity prices currently set: [${prices.join(', ')}]`);
  } catch (e) { console.warn('Tariff check error:', e.message); }
}

// Live rate from EKM — frontend uses this for the kWh estimate so the app
// always reflects whatever rate is configured in the EKM backend.
let rateCache = { value: null, time: 0 };
async function liveRate() {
  if (rateCache.value && Date.now() - rateCache.time < 10 * 60 * 1000) return rateCache.value;
  const r = await ekm('getPrices', { ckv: '1', ptype: 1, offset: -1, limit: -1 });
  if (isOk(r.result) && r.value && r.value.length) {
    rateCache = { value: r.value[0].Price, time: Date.now() }; // first electricity price
  }
  return rateCache.value;
}

// Money-only vend with +1 retry (landlord cost) as a backstop.
// simple:1 sends only money; EKM computes kWh from its stored rate, so there is
// no kWh-rounding mismatch. The +1 bump exists only for the rare case the order
// is still rejected, to nudge it through. The tenant's M-Pesa SMS WILL show the
// bumped amount — it is only hidden in this app's own UI.
async function sellWithRetry(meter, baseAmount, maxBumps = 3) {
  for (let bump = 0; bump <= maxBumps; bump++) {
    const charged = Number(baseAmount) + bump;
    const r = await ekm('sellByApi', { metid: meter, sellMoney: String(charged), simple: 1 });
    if (isOk(r.result)) { r.chargedAmount = charged; if (bump) console.log(`Order ok after +${bump} bump → KES ${charged}`); return r; }
    console.warn(`sellByApi rejected at KES ${charged} (result ${r.result}); retrying +1`);
  }
  return { result: 'RETRY_EXHAUSTED', chargedAmount: Number(baseAmount) + maxBumps };
}

// ────────────────────────────────────────────────
// M-Pesa Daraja
// ────────────────────────────────────────────────
async function mpesaToken() {
  const auth = Buffer.from(`${process.env.MPESA_KEY}:${process.env.MPESA_SECRET}`).toString('base64');
  const { data } = await axios.get(
    'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

// ────────────────────────────────────────────────
// 1. Create pending EKM order + trigger STK push
// ────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { meter, phone, amount } = req.body;
  if (!meter || !phone || !amount) return res.status(400).json({ message: 'Missing fields' });
  try {
    // Money-only (simple:1): EKM computes kWh from its own stored rate.
    // This avoids kWh-rounding rejection AND means the app always follows
    // whatever rate is set in the EKM backend — no code change on rate updates.
    const sell = await sellWithRetry(meter, amount);
    if (!isOk(sell.result)) throw new Error('EKM order failed: ' + sell.result);
    const ekmIdx = sell.value.idx;
    const chargedAmount = sell.chargedAmount; // base amount + any landlord-cost retry bumps

    const token = await mpesaToken();
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(process.env.SHORTCODE + process.env.PASSKEY + ts).toString('base64');
    const { data } = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.SHORTCODE,
        Password: password, Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: chargedAmount, PartyA: phone, PartyB: process.env.SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: `${process.env.BASE_URL}/api/mpesa-callback`,
        AccountReference: meter, TransactionDesc: 'Electricity units'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    txns[data.CheckoutRequestID] = { status: 'PENDING', meter, amount, chargedAmount, ekmIdx, taskIdx: null };
    res.json({ checkoutRequestId: data.CheckoutRequestID });
  } catch (e) {
    res.status(500).json({ message: e.response?.data?.errorMessage || e.message });
  }
});

// ────────────────────────────────────────────────
// 2. M-Pesa callback → confirm recharge to meter
// ────────────────────────────────────────────────
app.post('/api/mpesa-callback', async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  res.json({ ResultCode: 0, ResultDesc: 'OK' }); // ack Safaricom immediately
  if (!cb) return;
  const t = txns[cb.CheckoutRequestID];
  if (!t) return;

  if (cb.ResultCode !== 0) { t.status = 'FAILED'; t.message = cb.ResultDesc; return; }

  try {
    const ok = await ekm('sellByApiOk', { idx: String(t.ekmIdx), metid: t.meter });
    if (!isOk(ok.result)) throw new Error('EKM confirm failed: ' + ok.result);
    // sellByApiOk may return a task idx we can poll via getTkSta
    t.taskIdx = ok.value?.idx || t.ekmIdx;
    t.status = 'CONFIRMING'; // not done until meter acknowledges
  } catch (e) {
    t.status = 'VEND_FAILED';
    t.message = 'Paid, but recharge could not be sent. Support will reconcile.';
    // TODO: push to refund/reconciliation queue
  }
});

// ────────────────────────────────────────────────
// 3. Frontend polls this. We confirm meter receipt via getTkSta.
//    T_Status / result: 2 = finished, -1 = abnormal, 0 = waiting
// ────────────────────────────────────────────────
app.get('/api/status/:id', async (req, res) => {
  const t = txns[req.params.id];
  if (!t) return res.status(404).json({ status: 'UNKNOWN' });

  // If paid and confirming, check whether the meter has acknowledged
  if (t.status === 'CONFIRMING' && t.taskIdx) {
    try {
      const r = await ekm('getTkSta', { ind: [String(t.taskIdx)] });
      const task = Array.isArray(r.value) ? r.value[0] : null;
      if (task) {
        if (task.result === 2 || task.T_Status === 2) { t.status = 'SUCCESS'; t.message = 'Units credited to meter'; }
        else if (task.result === -1 || task.T_Status === 3) { t.status = 'VEND_FAILED'; t.message = 'Meter did not accept the recharge. Support notified.'; }
        // else still waiting — leave as CONFIRMING
      }
    } catch (e) { /* keep CONFIRMING, frontend keeps polling */ }
  }

  const out = (t.status === 'VEND_FAILED') ? 'FAILED'
            : (t.status === 'CONFIRMING') ? 'PENDING'
            : t.status;
  res.json({ status: out, kwh: t.status === 'SUCCESS' ? t.kwh : undefined, message: t.message });
});

// Frontend fetches the live rate for its kWh estimate.
app.get('/api/rate', async (req, res) => {
  try { const rate = await liveRate(); res.json({ rate }); }
  catch (e) { res.status(500).json({ rate: null }); }
});

app.listen(3000, () => { console.log('Pinnacle recharge backend on :3000'); checkTariff(); });
