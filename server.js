// server.js — Pinnacle Developments electricity recharge backend
// npm i express axios dotenv node-cron
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const app = express();
app.use(express.json());

// ────────────────────────────────────────────────
// Persistent storage (Tier 1 #3) — transactions survive restarts.
// Simple JSON file store: no native build, no external DB to manage.
// On Render, add a Persistent Disk mounted at /data so the file survives
// deploys/restarts. Without a disk it writes to ./data (works, but a fresh
// deploy wipes it — attach the disk for production money). Plenty fast for
// this transaction volume.
// ────────────────────────────────────────────────
const DB_DIR = fs.existsSync('/data') ? '/data' : '.';
const DB_FILE = `${DB_DIR}/recharge.json`;
let store = { txns: {}, meta: {} };
try { if (fs.existsSync(DB_FILE)) store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.warn('DB load failed, starting fresh:', e.message); }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(store)); } catch (e) { console.error('DB save failed:', e.message); }
  }, 100);
}
const dbGet = (id) => store.txns[id] || null;
function dbIns(row) { store.txns[row.checkoutId] = { vended: 0, ...row }; persist(); }
function setTxn(id, fields) { if (store.txns[id]) { Object.assign(store.txns[id], fields); persist(); } }
const metaGet = (k) => store.meta[k];
function metaSet(k, v) { store.meta[k] = v; persist(); }
function allTxns() { return Object.values(store.txns); }

const EKM_BASE = 'https://www.openapi.ekm365.com/api.ashx';
const EKM_API = process.env.EKM_API || '1212';
const EKM_AES_KEY = process.env.EKM_AES_KEY || '';
const isOk = (r) => String(r) === '200';

// ── CORS ──
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Basic per-IP rate limiting (Tier 2 #8): 60 req/min/IP ──
const hits = {};
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  hits[ip] = (hits[ip] || []).filter(t => now - t < 60000);
  hits[ip].push(now);
  if (hits[ip].length > 60) return res.status(429).json({ message: 'Too many requests. Please slow down.' });
  next();
});

app.get('/', (req, res) => res.send('Pinnacle recharge backend running.'));

// ── AES-encrypt apikey before use (EKM requirement) ──
function encryptApiKey(rawKey) {
  if (!EKM_AES_KEY) return rawKey;
  const bits = process.env.EKM_AES_BITS || '256';
  const keyBytes = bits === '128' ? Buffer.from(EKM_AES_KEY.slice(0, 16), 'utf8') : Buffer.from(EKM_AES_KEY, 'utf8');
  const algo = bits === '128' ? 'aes-128-ecb' : 'aes-256-ecb';
  const cipher = crypto.createCipheriv(algo, keyBytes, null);
  cipher.setAutoPadding(true);
  let enc = cipher.update(rawKey, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

// ── EKM auth ──
let ekmKey = null, ekmKeyTime = 0, ekmLoginId = null;
async function ekmApiKey() {
  if (ekmKey && Date.now() - ekmKeyTime < 20 * 3600 * 1000) return ekmKey;
  const { data } = await axios.post(`${EKM_BASE}?Method=login&api=${EKM_API}`,
    { nam: process.env.EKM_USER, psw: process.env.EKM_PASS });
  if (!isOk(data.result)) throw new Error('EKM login failed: ' + data.result);
  ekmKey = data.value.apiKey;
  ekmLoginId = data.value.LoginID || process.env.EKM_LOGINID;
  console.log('EKM login OK. LoginID:', ekmLoginId, '| AccType:', data.value.AccType);
  ekmKeyTime = Date.now();
  return ekmKey;
}

async function ekm(method, body) {
  const key = await ekmApiKey();
  const encKey = encryptApiKey(key);
  const url = `${EKM_BASE}?Method=${method}&api=${EKM_API}&apikey=${encodeURIComponent(encKey)}`;
  const payload = { loginid: ekmLoginId, ...body };
  if (method === 'sellByApi' || method === 'sellByApiOk') console.log(`→ ${method} body:`, JSON.stringify(payload));
  const { data } = await axios.post(url, payload);
  return data;
}

async function checkTariff() {
  try {
    const r = await ekm('getPrices', { ckv: '1', ptype: 1, offset: -1, limit: -1 });
    if (!isOk(r.result)) { console.warn('getPrices failed:', r.result); return; }
    console.log(`EKM electricity prices set: [${(r.value || []).map(p => p.Price).join(', ')}]`);
  } catch (e) { console.warn('Tariff check error:', e.message); }
}

async function meterRate(meterClean) {
  try {
    const ms = await ekm('getMetStatusByMetId', { metid: meterClean });
    if (ms && Number(ms.Price) > 0) return Number(ms.Price);
  } catch (e) { /* fall through */ }
  const pr = await ekm('getPrices', { ckv: '1', ptype: 1, offset: -1, limit: -1 });
  if (isOk(pr.result) && pr.value && pr.value.length) return Math.max(...pr.value.map(p => Number(p.Price)).filter(n => n > 0));
  return null;
}

async function findMeter(meterClean) {
  const list = await ekm('getMetList_Simple', { ckv: '', mt: 1, offset: -1, limit: -1 });
  const meters = (list.value && list.value.d) ? list.value.d : [];
  return meters.find(m => String(m.i) === meterClean) || null;
}

async function sellWithRetry(meter, baseAmount, rate, maxBumps = 3) {
  let lastResult = null;
  for (let bump = 0; bump <= maxBumps; bump++) {
    const charged = Number(baseAmount) + bump;
    const kwh = Math.round((charged / rate) * 100) / 100;
    const r = await ekm('sellByApi', { metid: meter, sellMoney: charged, sellKwh: kwh, simple: 0 });
    if (isOk(r.result)) { r.chargedAmount = charged; r.kwh = kwh; if (bump) console.log(`Order ok after +${bump} bump`); return r; }
    lastResult = r.result;
    console.warn(`sellByApi rejected at KES ${charged} — result ${r.result}`);
  }
  return { result: 'RETRY_EXHAUSTED', lastResult, chargedAmount: Number(baseAmount) + maxBumps };
}

// ── M-Pesa ──
const MPESA_BASE = (process.env.MPESA_ENV === 'sandbox') ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
async function mpesaToken() {
  const auth = Buffer.from(`${process.env.MPESA_KEY}:${process.env.MPESA_SECRET}`).toString('base64');
  const { data } = await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } });
  return data.access_token;
}

// ── Email (Resend). If no key set, logs instead of sending (safe no-op). ──
async function sendEmail(subject, html) {
  const to = process.env.ALERT_EMAIL;
  const from = process.env.MAIL_FROM || 'onboarding@resend.dev';
  if (!process.env.RESEND_API_KEY || !to) { console.log(`[email skipped — set RESEND_API_KEY + ALERT_EMAIL] ${subject}`); return; }
  try {
    await axios.post('https://api.resend.com/emails', { from, to, subject, html },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    console.log(`Email sent: ${subject}`);
  } catch (e) { console.error('Email send failed:', e.response?.data || e.message); }
}

// ── Input validation (Tier 2 #9) ──
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT || 10);
const MAX_AMOUNT = Number(process.env.MAX_AMOUNT || 10000);
function validInputs(meter, phone, amount) {
  const m = String(meter || '').replace(/\D/g, '');
  let p = String(phone || '').replace(/\s/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  const a = Number(amount);
  if (m.length < 9 || m.length > 12) return { ok: false, msg: 'Invalid meter number.' };
  if (!/^254(7|1)\d{8}$/.test(p)) return { ok: false, msg: 'Enter a valid Safaricom number.' };
  if (!Number.isFinite(a) || a < MIN_AMOUNT || a > MAX_AMOUNT) return { ok: false, msg: `Amount must be between KES ${MIN_AMOUNT} and ${MAX_AMOUNT}.` };
  return { ok: true, meter: m, phone: p, amount: Math.round(a) };
}

// ════ 1. Create pending EKM order + trigger STK push ════
app.post('/api/stk-push', async (req, res) => {
  const v = validInputs(req.body.meter, req.body.phone, req.body.amount);
  if (!v.ok) return res.status(400).json({ message: v.msg });
  const { meter, phone, amount } = v;
  console.log(`Recharge request — meter ${meter} | amount ${amount}`);
  try {
    const match = await findMeter(meter);
    if (!match) return res.status(400).json({ message: 'Meter number not found. Please check and try again.' });
    if (match.s === 1 || match.s === 2) return res.status(400).json({ message: 'This meter is currently offline. Please try again shortly or contact support.' });

    const rate = await meterRate(meter);
    if (!rate || rate <= 0) return res.status(500).json({ message: 'Could not determine the tariff. Please try again shortly.' });

    const sell = await sellWithRetry(meter, amount, rate);
    if (!isOk(sell.result)) throw new Error('EKM order failed: ' + (sell.lastResult ? `EKM code ${sell.lastResult}` : sell.result));

    const token = await mpesaToken();
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(process.env.SHORTCODE + process.env.PASSKEY + ts).toString('base64');
    const { data } = await axios.post(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.SHORTCODE, Password: password, Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: sell.chargedAmount, PartyA: phone, PartyB: process.env.SHORTCODE, PhoneNumber: phone,
        CallBackURL: `${process.env.BASE_URL}/api/mpesa-callback`,
        AccountReference: meter, TransactionDesc: 'Electricity units'
      },
      { headers: { Authorization: `Bearer ${token}` } });

    dbIns({
      checkoutId: data.CheckoutRequestID, meter, phone, amount,
      chargedAmount: sell.chargedAmount, kwh: sell.kwh, ekmIdx: String(sell.value.idx),
      taskIdx: null, status: 'PENDING', createdAt: new Date().toISOString()
    });
    res.json({ checkoutRequestId: data.CheckoutRequestID });
  } catch (e) {
    res.status(500).json({ message: e.response?.data?.errorMessage || e.message });
  }
});

// ════ 2. M-Pesa callback → verify amount, release units ONCE ════
app.post('/api/mpesa-callback', async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  res.json({ ResultCode: 0, ResultDesc: 'OK' });
  if (!cb) return;
  const t = dbGet(cb.CheckoutRequestID);
  if (!t) return;

  if (t.vended === 1) { console.log(`Duplicate callback for ${cb.CheckoutRequestID} ignored.`); return; }
  if (cb.ResultCode !== 0) { setTxn(t.checkoutId, { status: 'FAILED', message: cb.ResultDesc }); return; }

  let paidAmount = null, receipt = null;
  for (const it of (cb.CallbackMetadata?.Item || [])) {
    if (it.Name === 'Amount') paidAmount = Number(it.Value);
    if (it.Name === 'MpesaReceiptNumber') receipt = it.Value;
  }

  if (paidAmount !== null && Number(paidAmount) < Number(t.chargedAmount)) {
    setTxn(t.checkoutId, { status: 'FAILED', paidAmount, mpesaReceipt: receipt, message: `Underpaid: expected ${t.chargedAmount}, got ${paidAmount}` });
    console.warn(`Amount mismatch on ${t.checkoutId}`);
    return;
  }

  setTxn(t.checkoutId, { vended: 1, paidAmount, mpesaReceipt: receipt, paidAt: new Date().toISOString() });

  try {
    const ok = await ekm('sellByApiOk', { idx: String(t.ekmIdx), metid: t.meter });
    if (!isOk(ok.result)) throw new Error('EKM confirm failed: ' + ok.result);
    setTxn(t.checkoutId, { taskIdx: String(ok.value?.idx || t.ekmIdx), status: 'CONFIRMING' });
  } catch (e) {
    setTxn(t.checkoutId, { status: 'VEND_FAILED', message: 'Paid, but recharge could not be sent. Support will reconcile.' });
    sendEmail('Pinnacle: vend FAILED after payment',
      `<p>A tenant PAID but units could not be released. Manual action needed.</p>
       <p>Meter: ${t.meter}<br>Amount: KES ${t.chargedAmount}<br>Receipt: ${receipt || '-'}<br>Checkout: ${t.checkoutId}</p>`);
  }

  checkRevenueAlert(Number(paidAmount || t.chargedAmount));
});

// ════ 3. Status polling ════
app.get('/api/status/:id', async (req, res) => {
  const t = dbGet(req.params.id);
  if (!t) return res.status(404).json({ status: 'UNKNOWN' });
  if (t.status === 'CONFIRMING' && t.taskIdx) {
    try {
      const r = await ekm('getTkSta', { ind: [String(t.taskIdx)] });
      const task = Array.isArray(r.value) ? r.value[0] : null;
      if (task) {
        if (task.result === 2 || task.T_Status === 2) setTxn(t.checkoutId, { status: 'SUCCESS', message: 'Units credited to meter' });
        else if (task.result === -1 || task.T_Status === 3) setTxn(t.checkoutId, { status: 'VEND_FAILED', message: 'Meter did not accept the recharge. Support notified.' });
      }
    } catch (e) { /* keep polling */ }
  }
  const cur = dbGet(req.params.id);
  const out = (cur.status === 'VEND_FAILED') ? 'FAILED' : (cur.status === 'CONFIRMING') ? 'PENDING' : cur.status;
  res.json({ status: out, kwh: cur.status === 'SUCCESS' ? cur.kwh : undefined, message: cur.message });
});

// ════ 4. Balance check ════
app.get('/api/balance/:meter', async (req, res) => {
  const meter = String(req.params.meter || '').replace(/\D/g, '');
  if (meter.length < 9) return res.status(400).json({ message: 'Invalid meter number.' });
  try {
    const match = await findMeter(meter);
    if (!match) return res.status(404).json({ message: 'Meter number not found.' });
    res.json({ meter, name: match.n, balanceKwh: match.e, status: match.s, online: !(match.s === 1 || match.s === 2) });
  } catch (e) {
    res.status(500).json({ message: 'Could not check balance right now. Please try again.' });
  }
});

app.get('/api/rate', async (req, res) => {
  try {
    const pr = await ekm('getPrices', { ckv: '1', ptype: 1, offset: -1, limit: -1 });
    const rate = (isOk(pr.result) && pr.value && pr.value.length) ? Math.max(...pr.value.map(p => Number(p.Price)).filter(n => n > 0)) : null;
    res.json({ rate });
  } catch (e) { res.status(500).json({ rate: null }); }
});

// ════ 250k revenue alert (running total since last reset) ════
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || 250000);
function checkRevenueAlert(addAmount) {
  let running = Number(metaGet('runningTotal') || 0) + Number(addAmount || 0);
  metaSet('runningTotal', String(running));
  if (running >= ALERT_THRESHOLD) {
    sendEmail(`Pinnacle: collections reached KES ${running.toLocaleString()}`,
      `<p>M-Pesa collections have reached <b>KES ${running.toLocaleString()}</b> since the last reset.</p>
       <p>The running total has now been reset to zero for the next cycle.</p>`);
    metaSet('runningTotal', '0');
  }
}

// ════ Weekly reconciliation digest ════
function buildWeeklyReport() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = allTxns().filter(r => r.createdAt && r.createdAt >= weekAgo).sort((a,b)=>a.createdAt<b.createdAt?-1:1);
  const paid = rows.filter(r => r.paidAt);
  const success = rows.filter(r => r.status === 'SUCCESS');
  const vendFailed = rows.filter(r => r.status === 'VEND_FAILED');
  const totalPaid = paid.reduce((s, r) => s + Number(r.paidAmount || r.chargedAmount || 0), 0);
  const totalKwh = success.reduce((s, r) => s + Number(r.kwh || 0), 0);
  const fmt = n => 'KES ' + Number(n).toLocaleString();
  let html = `<h2>Pinnacle Recharge - Weekly Report</h2>
    <p>${new Date(weekAgo).toDateString()} to ${new Date().toDateString()}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td>Payments received</td><td><b>${paid.length}</b></td></tr>
      <tr><td>Total collected</td><td><b>${fmt(totalPaid)}</b></td></tr>
      <tr><td>Successful recharges</td><td><b>${success.length}</b> (${totalKwh.toFixed(1)} kWh)</td></tr>
      <tr><td style="color:#b3261e">Paid but NO units (action needed)</td><td><b style="color:#b3261e">${vendFailed.length}</b></td></tr>
    </table>`;
  if (vendFailed.length) {
    html += `<h3 style="color:#b3261e">Mismatches to resolve</h3><ul>`;
    for (const r of vendFailed) html += `<li>Meter ${r.meter} - ${fmt(r.chargedAmount)} - receipt ${r.mpesaReceipt || '-'} - ${r.createdAt}</li>`;
    html += `</ul><p>These tenants paid but did not receive units. Refund or manually re-vend.</p>`;
  } else {
    html += `<p style="color:#147a3a">No mismatches - every payment delivered units.</p>`;
  }
  return html;
}

// Weekly digest: Mondays 04:00 UTC (07:00 EAT).
cron.schedule('0 4 * * 1', () => { sendEmail('Pinnacle Recharge - Weekly Report', buildWeeklyReport()); });

app.listen(3000, () => { console.log('Pinnacle recharge backend on :3000'); checkTariff(); });
