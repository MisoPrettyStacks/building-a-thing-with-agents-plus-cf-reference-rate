// Browser app: live chart, official forecast, live scoreboard, in-browser replay, agent panel, source download.
// All numbers come from real exchange data or from the public ledger. Nothing here is simulated.
import { coinbaseCandles, fetchBars } from './lib/data.js';
import { walkForward, gridBars, DEFAULT_CONFIG, QLEVELS, STEP } from './lib/engine.js';
import { binaryScores, quantileScores, dmTest, brier, mean } from './lib/stats.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (x, d = 4) => (x === null || x === undefined || !isFinite(x) ? '—' : Number(x).toFixed(d));
const pct = (x, d = 2) => (x === null || x === undefined || !isFinite(x) ? '—' : (100 * x).toFixed(d) + '%');
const usd = (x, d = 4) => (isFinite(x) ? '$' + Number(x).toFixed(d) : '—');
const hhmm = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const stamp = (t) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------------- where the data lives ---------------- */
let DATA_BASE = './data/';
let RAW_MAIN = null;
let REPO_URL = null;
async function resolveBases() {
  let cfg = {};
  try { cfg = await (await fetch('site-config.json', { cache: 'no-store' })).json(); } catch { /* optional */ }
  const q = new URLSearchParams(location.search).get('data');
  const host = location.hostname;
  let owner = null, repo = null;
  if (host.endsWith('.github.io')) { owner = host.split('.')[0]; repo = location.pathname.split('/')[1] || null; }
  if (cfg.repo && cfg.repo.includes('/')) [owner, repo] = cfg.repo.split('/');
  if (owner && repo) {
    DATA_BASE = `https://raw.githubusercontent.com/${owner}/${repo}/data/`;
    RAW_MAIN = `https://raw.githubusercontent.com/${owner}/${repo}/main/`;
    REPO_URL = `https://github.com/${owner}/${repo}`;
  }
  if (cfg.dataBase) DATA_BASE = cfg.dataBase.endsWith('/') ? cfg.dataBase : cfg.dataBase + '/';
  if (q) DATA_BASE = q.endsWith('/') ? q : q + '/';
}

let summary = null, champion = null;
async function loadSummary() {
  try {
    const r = await fetch(DATA_BASE + 'summary.json?m=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    summary = await r.json();
  } catch { summary = null; }
  renderHeartbeat(); renderForecast(); renderScore(currentWin); renderAgent(); renderIntegrity(); schedDraw();
}

/* ---------------- live price + chart ---------------- */
const chart = { candles: [], last: null, viewMin: null };
let ws = null, wsAlive = 0;

async function loadCandles() {
  const now = Math.floor(Date.now() / 1000);
  try {
    const rows = await coinbaseCandles(now - 239 * 60, now, 60);
    if (rows.length) { chart.candles = rows; chart.last = rows[rows.length - 1].c; setPrice(chart.last); }
  } catch (e) { $('wsText').textContent = 'candle feed unavailable'; }
  schedDraw();
}
function setPrice(p) { chart.last = p; $('px').textContent = '$' + p.toFixed(4); $('pxTime').textContent = new Date().toLocaleTimeString(); }
function onTick(price, tsMs) {
  const minute = Math.floor(tsMs / 60000) * 60;
  const cs = chart.candles;
  setPrice(price);
  if (!cs.length) return;
  const last = cs[cs.length - 1];
  if (last.t === minute) { last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); }
  else if (minute > last.t) { cs.push({ t: minute, o: price, h: price, l: price, c: price, v: 0 }); if (cs.length > 1600) cs.shift(); }
  schedDraw();
}
function connectWS() {
  try { ws = new WebSocket('wss://ws-feed.exchange.coinbase.com'); } catch { return; }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['XRP-USD'], channels: ['ticker'] }));
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'ticker' && m.price) { wsAlive = Date.now(); onTick(parseFloat(m.price), m.time ? Date.parse(m.time) : Date.now()); }
    } catch { /* ignore */ }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}
async function pollTicker() {
  if (Date.now() - wsAlive < 8000) return;
  try {
    const r = await fetch('https://api.exchange.coinbase.com/products/XRP-USD/ticker');
    const j = await r.json();
    if (j.price) onTick(parseFloat(j.price), Date.now());
  } catch { /* ignore */ }
}
function renderFeedBadge() {
  const live = Date.now() - wsAlive < 8000;
  $('wsDot').className = 'dot ' + (live ? 'ok' : chart.last ? 'warn' : 'bad');
  $('wsText').textContent = live ? 'live tick feed' : chart.last ? 'polling price' : 'price feed offline';
}

let drawQueued = false;
function schedDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawChart(); }); } }

/* ---------------- chart zoom (visible time window only; nothing else changes) ---------------- */
const ZMIN = 15, ZMAX = 1440; // minutes
let histLoading = false;
async function ensureHistory(minutes) {
  const need = Math.min(Math.ceil(minutes) + 2, ZMAX);
  const haveMin = chart.candles.length ? (Date.now() / 1000 - chart.candles[0].t) / 60 : 0;
  if (haveMin >= need || histLoading) return;
  histLoading = true;
  try {
    const bars = await fetchBars(need + 5, { step: 60 });
    const m = new Map(bars.map((b) => [b.t, b]));
    for (const c of chart.candles) m.set(c.t, c); // live candles win on overlap
    chart.candles = [...m.values()].sort((a, b) => a.t - b.t);
  } catch { /* keep whatever history we already have */ }
  histLoading = false;
  schedDraw();
}
function setZoom(minutes) {
  chart.viewMin = minutes == null ? null : Math.min(ZMAX, Math.max(ZMIN, minutes));
  if (chart.viewMin != null) ensureHistory(chart.viewMin);
  schedDraw();
}
function zoomBy(f) {
  const cs = chart.candles;
  if (!cs.length) return;
  const cur = chart.viewMin == null ? (cs[cs.length - 1].t + 60 - cs[0].t) / 60 : chart.viewMin;
  setZoom(cur * f);
}
function fmtSpan(m) { return 'last ' + (m >= 60 ? (m / 60).toFixed(1).replace(/\.0$/, '') + 'h' : Math.round(m) + 'm'); }

function drawChart() {
  const cv = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cs = chart.candles;
  const ink = css('--ink'), muted = css('--muted'), line = css('--line'), up = css('--up'), down = css('--down'), accent = css('--accent');
  if (!cs.length) { ctx.fillStyle = muted; ctx.font = '14px system-ui'; ctx.fillText('Waiting for real-time candles…', 20, 40); return; }
  const pad = { l: 8, r: 64, t: 12, b: 24 };
  const tEnd = cs[cs.length - 1].t + 60;
  const spanMin = (tEnd - cs[0].t) / 60;
  const viewMin = chart.viewMin == null ? spanMin : Math.min(chart.viewMin, spanMin);
  const tMin = tEnd - viewMin * 60;
  const zl = $('zlabel');
  if (zl) zl.textContent = chart.viewMin == null ? 'all' : fmtSpan(viewMin);
  const fc = summary?.latest;
  const nowS = Date.now() / 1000;
  const showCone = fc && fc.q && nowS - fc.t_issue < 45 * 60 && fc.t_issue >= tMin;
  const tMax = Math.max(tEnd + 120, showCone ? fc.target_t + 120 : 0);
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { if (c.t < tMin) continue; lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  if (showCone) { lo = Math.min(lo, fc.c0 * Math.exp(fc.q[0])); hi = Math.max(hi, fc.c0 * Math.exp(fc.q[6])); }
  const m = (hi - lo) * 0.06 || hi * 0.001; lo -= m; hi += m;
  const X = (t) => pad.l + ((t - tMin) / (tMax - tMin)) * (W - pad.l - pad.r);
  const Y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * (H - pad.t - pad.b);
  ctx.font = '11px system-ui'; ctx.textBaseline = 'middle';
  // grid
  ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.fillStyle = muted;
  for (let i = 0; i <= 5; i++) {
    const p = lo + ((hi - lo) * i) / 5, y = Y(p);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(p.toFixed(4), W - pad.r + 6, y);
  }
  ctx.textBaseline = 'alphabetic';
  const tick = (viewMin <= 60 ? 10 : viewMin <= 180 ? 30 : viewMin <= 720 ? 120 : 240) * 60;
  for (let t = Math.ceil(tMin / tick) * tick; t < tMax; t += tick) {
    const x = X(t);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
    ctx.fillText(hhmm(t), x - 14, H - 7);
  }
  // forecast cone
  if (showCone) {
    const x0 = X(fc.t_issue), x1 = X(fc.target_t), y0 = Y(fc.c0);
    const qp = (k) => Y(fc.c0 * Math.exp(fc.q[k]));
    const band = (a, b, alpha) => {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, qp(a)); ctx.lineTo(x1, qp(b)); ctx.closePath();
      ctx.globalAlpha = alpha; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
    };
    band(0, 6, 0.12); band(2, 4, 0.22);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, qp(3)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, pad.t); ctx.lineTo(x1, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ink; ctx.font = '600 12px system-ui';
    ctx.fillText(`P(up) ${(fc.p * 100).toFixed(1)}%`, Math.max(pad.l + 4, x1 - 92), Math.max(pad.t + 12, qp(6) - 8));
  }
  // candles
  const pxMin = (W - pad.l - pad.r) / ((tMax - tMin) / 60);
  const bw = Math.max(1, pxMin * 0.7);
  for (const c of cs) {
    const x = X(c.t + 30), col = c.c >= c.o ? up : down;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
    const yo = Y(c.o), yc = Y(c.c);
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yo - yc)));
  }
  // scored-forecast markers
  if (summary?.recent) {
    for (const r of summary.recent) {
      if (r.t < tMin || r.t > tEnd) continue;
      const hit = r.p === 0.5 ? null : (r.p > 0.5) === (r.y === 1);
      ctx.fillStyle = hit === null ? muted : hit ? up : down;
      ctx.strokeStyle = css('--panel'); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(r.t), Y(r.c0), 3.5, 0, 6.2832); ctx.fill(); ctx.stroke();
    }
  }
  // last price tag
  const lp = chart.last ?? cs[cs.length - 1].c, yl = Y(lp);
  ctx.strokeStyle = ink; ctx.globalAlpha = 0.35; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(pad.l, yl); ctx.lineTo(W - pad.r, yl); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.fillStyle = ink; ctx.fillRect(W - pad.r + 1, yl - 9, pad.r - 2, 18);
  ctx.fillStyle = css('--bg'); ctx.font = '600 11px system-ui'; ctx.fillText(lp.toFixed(4), W - pad.r + 5, yl + 4);
}

/* ---------------- heartbeat + forecast card ---------------- */
function renderHeartbeat() {
  const d = $('hbDot'), t = $('hbText');
  if (!summary) { d.className = 'dot bad'; t.textContent = 'runner has not published yet'; return; }
  const age = (Date.now() - Date.parse(summary.health?.heartbeat || summary.generated_at)) / 60000;
  d.className = 'dot ' + (age < 12 ? 'ok' : age < 60 ? 'warn' : 'bad');
  t.textContent = age < 12 ? `runner live · ${summary.counts.forecasts.toLocaleString()} forecasts issued` : `runner last seen ${Math.round(age)} min ago`;
}
function renderForecast() {
  const L = summary?.latest;
  if (!L) { $('pUp').textContent = '—'; $('fcNext').textContent = 'waiting for the first forecast'; return; }
  $('pUp').textContent = (L.p * 100).toFixed(1) + '%';
  $('pBar').style.width = (L.p * 100).toFixed(1) + '%';
  $('fcIssued').textContent = stamp(L.t_issue);
  $('fcResolve').textContent = L.res ? `${stamp(L.target_t)} → ${L.res.y === 1 ? 'went up' : L.res.y === 0 ? 'went down' : 'unchanged'} (${usd(L.res.c1)})` : stamp(L.target_t) + ' (pending)';
  $('fcC0').textContent = usd(L.c0);
  if (L.q) {
    $('fcI50').textContent = `${usd(L.c0 * Math.exp(L.q[2]))} – ${usd(L.c0 * Math.exp(L.q[4]))}`;
    $('fcI90').textContent = `${usd(L.c0 * Math.exp(L.q[0]))} – ${usd(L.c0 * Math.exp(L.q[6]))}`;
  }
  $('fcVer').textContent = `v${L.cfg_version} · ${L.cfg_hash}`;
}
function tickCountdown() {
  const t = Date.now() / 1000, next = (Math.floor(t / 300) + 1) * 300 + 10, s = Math.max(0, Math.round(next - t));
  $('fcNext').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  renderFeedBadge();
  renderWindow();
}

/* ---------------- 15-minute window panel (:00/:15/:30/:45) ---------------- */
function windowBounds(nowMs) {
  const s = Math.floor(nowMs / 1000);
  const start = Math.floor(s / 900) * 900;
  return { start, end: start + 900 };
}
const fmtET = (tsMs) => new Date(tsMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
function renderWindow() {
  if (!$('wCard')) return;
  const now = Date.now();
  const { start, end } = windowBounds(now);
  $('wRange').textContent = `${fmtET(start * 1000)} – ${fmtET(end * 1000)} ET`;
  const s = Math.max(0, end - Math.floor(now / 1000));
  $('wCount').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const W = summary?.window_fc;
  if (!W || W.p == null || !W.c0) {
    $('wPup').textContent = '—'; $('wPdown').textContent = '—'; $('wRef').textContent = '—';
    $('wPx').textContent = '—'; $('wVs').textContent = 'waiting for the window forecast';
    return;
  }
  $('wPup').textContent = (W.p * 100).toFixed(1) + '%';
  $('wBar').style.width = (W.p * 100).toFixed(1) + '%';
  $('wPdown').textContent = ((1 - W.p) * 100).toFixed(1) + '%';
  $('wRef').textContent = usd(W.c0);
  $('wPx').textContent = W.q ? usd(W.c0 * Math.exp(W.q[3])) : '—';
  const last = chart.last;
  if (last && W.c0) {
    const bps = (last / W.c0 - 1) * 1e4;
    $('wVs').innerHTML = `<span class="${bps >= 0 ? 'up' : 'down'}">${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps ${bps >= 0 ? 'above' : 'below'}</span>`;
  } else $('wVs').textContent = '—';
}

/* ---------------- score tiles + diagrams ---------------- */
let currentWin = 'all';
const tile = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
function verdict(dm, label) {
  if (!dm || !isFinite(dm.pALess)) return 'n/a';
  const better = dm.dbar < 0;
  const p = better ? dm.pALess : dm.pBLess;
  return `p = ${p < 0.001 ? '<0.001' : p.toFixed(3)} (${better ? 'better' : 'worse'} than ${label})`;
}
function metricsHtml(w, { showMembers = true } = {}) {
  const ci = w.brierCI ? `95% CI ${f(w.brierCI[0], 4)}–${f(w.brierCI[1], 4)}` : '';
  const sig = w.dmVs50 && w.dmVs50.dbar < 0 && w.dmVs50.pALess < 0.05;
  let h = '<div class="grid g4">';
  h += tile('Scored forecasts', w.n.toLocaleString(), `effective n ≈ ${Math.round(w.nEff)} (overlap-adjusted)`);
  h += tile('Brier score', f(w.brier, 5), `${ci} · no-skill = 0.25000`);
  h += tile('Skill vs 50% (BSS)', pct(w.bss50, 3), w.dmVs50 ? verdict(w.dmVs50, '50%') : '');
  h += tile('Skill vs climatology', pct(w.bssBase, 3), w.dmVsBase ? verdict(w.dmVsBase, 'climatology') : `climatology Brier ${f(w.brierBase, 5)}`);
  h += tile('Log loss', f(w.logloss, 5), 'no-skill = 0.69315');
  h += tile('Direction hit rate', pct(w.accuracy, 2), w.accCI ? `95% CI ${pct(w.accCI[0], 1)}–${pct(w.accCI[1], 1)} · p=${f(w.accP, 3)}` : '');
  h += tile('Calibration error (ECE)', f(w.ece, 4), `REL ${f(w.rel, 5)} · RES ${f(w.res, 5)} · UNC ${f(w.unc, 4)}`);
  h += tile('Calibration slope β', w.calib ? f(w.calib.beta, 2) : '—', w.calib ? `α ${f(w.calib.alpha, 3)} ± ${f(w.calib.seAlpha, 3)} · β ± ${f(w.calib.seBeta, 2)} (ideal 0, 1)` : 'needs more forecasts');
  if (w.interval?.n) {
    h += tile('Interval coverage', `${pct(w.interval.c50, 1)} / ${pct(w.interval.c80, 1)} / ${pct(w.interval.c90, 1)}`, 'targets 50% / 80% / 90%');
    h += tile('Pinball loss', f(w.interval.pinballBps, 3) + ' bps', 'mean over 7 quantiles');
  }
  if (w.ladder) {
    h += tile('Strike-ladder Brier', f(w.ladder.brier, 5), `threshold contracts at ±10/25/40 bps · per-strike climatology ${f(w.ladder.climatology, 5)} · n=${w.ladder.n}`);
  }
  if (showMembers && w.members) {
    h += tile('Member Brier scores', Object.entries(w.members).map(([k, v]) => `${k} ${f(v, 5)}`).join('<br>'), '');
  }
  h += '</div>';
  h += `<p class="${sig ? 'up' : 'muted'}" style="margin:12px 0 0">${sig
    ? 'The forecasts beat the no-skill 50% baseline with statistical significance at the 5% level (Diebold–Mariano, overlap-robust).'
    : 'No statistically significant skill over 50% yet. For a near-efficient 15-minute market this is the expected state until the sample is large; the agent keeps the forecasts calibrated and shrunk accordingly.'}</p>`;
  return h;
}
function drawReliability(cv, bins, deff, note) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const muted = css('--muted'), line = css('--line'), accent = css('--accent'), ink = css('--ink');
  const pad = { l: 44, r: 12, t: 12, b: 34 };
  if (!bins || bins.length < 2) { ctx.fillStyle = muted; ctx.font = '13px system-ui'; ctx.fillText('Reliability diagram appears once there are enough forecasts.', 16, 30); return; }
  let lo = 1, hi = 0;
  for (const b of bins) {
    const se = 1.96 * Math.sqrt(Math.max(b.y * (1 - b.y), 0.05) / Math.max(1, b.n / deff));
    lo = Math.min(lo, b.p, b.y - se); hi = Math.max(hi, b.p, b.y + se);
  }
  lo = Math.max(0, Math.min(lo, 0.5) - 0.01); hi = Math.min(1, Math.max(hi, 0.5) + 0.01);
  const X = (v) => pad.l + ((v - lo) / (hi - lo)) * (W - pad.l - pad.r), Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
    ctx.fillText((v * 100).toFixed(1) + '%', 2, Y(v) + 4);
    ctx.fillText((v * 100).toFixed(1) + '%', X(v) - 14, H - 18);
  }
  ctx.fillText('forecast probability →', W / 2 - 50, H - 4);
  ctx.save(); ctx.translate(10, H / 2 + 40); ctx.rotate(-Math.PI / 2); ctx.fillText('observed frequency →', 0, 0); ctx.restore();
  ctx.strokeStyle = muted; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(lo), Y(lo)); ctx.lineTo(X(hi), Y(hi)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineWidth = 1.5;
  for (const b of bins) {
    const se = 1.96 * Math.sqrt(Math.max(b.y * (1 - b.y), 0.05) / Math.max(1, b.n / deff));
    ctx.beginPath(); ctx.moveTo(X(b.p), Y(Math.max(lo, b.y - se))); ctx.lineTo(X(b.p), Y(Math.min(hi, b.y + se))); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(b.p), Y(b.y), 4, 0, 6.2832); ctx.fill();
  }
  ctx.fillStyle = ink;
  if (note) { ctx.fillStyle = muted; ctx.font = '11px system-ui'; ctx.fillText(note, pad.l + 6, pad.t + 12); }
}
function drawRolling(cv, series) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const muted = css('--muted'), line = css('--line'), accent = css('--accent'), warn = css('--warn');
  if (!series || series.length < 3) { ctx.fillStyle = muted; ctx.font = '13px system-ui'; ctx.fillText('Rolling 12-hour Brier appears after 144 scored forecasts.', 16, 30); return; }
  const vals = series.flatMap((s) => [s.model, s.base]).concat(0.25);
  let lo = Math.min(...vals), hi = Math.max(...vals); const m = (hi - lo) * 0.1 || 0.002; lo -= m; hi += m;
  const pad = { l: 52, r: 12, t: 12, b: 28 };
  const X = (i) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r), Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.font = '11px system-ui';
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4; ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(4), 2, Y(v) + 4); }
  const path = (key, col, dash) => { ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.setLineDash(dash || []); ctx.beginPath(); series.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s[key])) : ctx.moveTo(X(i), Y(s[key])))); ctx.stroke(); ctx.setLineDash([]); };
  ctx.strokeStyle = muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(pad.l, Y(0.25)); ctx.lineTo(W - pad.r, Y(0.25)); ctx.stroke(); ctx.setLineDash([]);
  path('base', warn, [5, 4]); path('model', accent);
  ctx.fillStyle = accent; ctx.fillText('model', pad.l + 6, H - 8); ctx.fillStyle = warn; ctx.fillText('climatology', pad.l + 56, H - 8); ctx.fillStyle = muted; ctx.fillText('0.25 no-skill (dotted)', pad.l + 140, H - 8);
}
function renderScore(win) {
  currentWin = win;
  document.querySelectorAll('#winTabs button').forEach((b) => b.classList.toggle('on', b.dataset.w === win));
  const body = $('scoreBody');
  const w = summary?.windows?.[win];
  if (!summary) { body.innerHTML = '<div class="empty">The runner has not published a scoreboard yet. Deploy the workflow (see README) and this fills in automatically.</div>'; return; }
  if (!w || !w.n) {
    body.innerHTML = `<div class="empty">No scored live forecasts in this window yet (${summary.counts.forecasts} issued, ${summary.counts.pending} pending). Forecasts are scored 15 minutes after they are issued; statistics appear as soon as there is data. Nothing is pre-filled.</div>`;
    return;
  }
  body.innerHTML = metricsHtml(w) + '<div class="grid g2" style="margin-top:14px"><div><h3>Reliability (equal-count bins, 95% bars use overlap-adjusted n)</h3><canvas id="relCv" class="canvas-sm"></canvas></div><div><h3>Rolling 12-hour Brier: model vs climatology</h3><canvas id="rollCv" class="canvas-sm"></canvas></div></div>';
  let rb = w.bins, rnote = '';
  const ab = summary.windows && summary.windows.all && summary.windows.all.bins;
  if ((!rb || rb.length < 2) && win !== 'all' && ab && ab.length >= 2) {
    rb = ab; rnote = 'not enough in this window yet — showing all-time';
  }
  drawReliability($('relCv'), rb, w.deff || 2.36, rnote);
  drawRolling($('rollCv'), win === 'all' ? summary.rolling : null);
}

/* ---------------- in-browser replay ---------------- */
async function runBacktest() {
  const st = $('btStatus'), body = $('btBody');
  try {
    let cfg = DEFAULT_CONFIG, src = 'default configuration (the runner has not published one yet)';
    try { const r = await fetch(DATA_BASE + 'config.json', { cache: 'no-store' }); if (r.ok) { cfg = (await r.json()).champion; src = 'the agent’s current champion configuration v' + cfg.version; } } catch { /* fall back */ }
    champion = cfg;
    st.textContent = 'Downloading ~2,600 real 5-minute candles from Coinbase (about 9 days)…';
    const raw = await fetchBars(2600);
    const lastStart = raw[raw.length - 1].t;
    const bars = gridBars(raw, STEP, lastStart);
    st.textContent = `Replaying ${bars.length.toLocaleString()} bars through the production engine…`;
    await new Promise((r) => setTimeout(r, 30));
    const evalFrom = 1000;
    const { steps } = walkForward(bars, cfg, { quantFrom: evalFrom });
    const S = steps.filter((s) => s.i >= evalFrom && s.y !== null);
    const ps = S.map((s) => s.p), ys = S.map((s) => s.y);
    const sc = binaryScores(ps, ys, { h: cfg.h });
    const lm = ps.map((p, i) => brier(p, ys[i])), lb = S.map((s, i) => brier(s.m[0], ys[i])), l5 = ys.map(() => 0.25);
    const w = {
      ...sc, brierBase: mean(lb), bssBase: 1 - sc.brier / mean(lb),
      dmVs50: dmTest(lm, l5, { h: cfg.h }), dmVsBase: dmTest(lm, lb, { h: cfg.h }),
      members: Object.fromEntries(['base', 'logit', 'drift', 'short'].map((nm, k) => [nm, mean(S.map((s, i) => brier(s.m[k], ys[i])))])),
      interval: quantileScores(S.filter((s) => s.q).map((s) => ({ q: s.q, r: s.r })), QLEVELS),
    };
    st.innerHTML = `Replayed <b>${S.length.toLocaleString()}</b> forecasts from ${stamp(S[0].t + 300)} to ${stamp(S[S.length - 1].t + 300)} using ${esc(src)}. First ${evalFrom} bars were warm-up.`;
    body.innerHTML = metricsHtml(w) + '<div style="margin-top:14px"><h3>Reliability (replay)</h3><canvas id="btRel" class="canvas-sm"></canvas></div>';
    drawReliability($('btRel'), sc.bins, sc.deff);
  } catch (e) {
    st.innerHTML = `<span class="down">Could not run the replay: ${esc(e.message || e)}</span> (your network may block the exchange API).`;
  }
}

/* ---------------- agent + integrity panels ---------------- */
function describeEvent(e) {
  const ev = e.evidence;
  switch (e.type) {
    case 'search':
      return `<span class="tag">search</span>${esc(e.decision)}${e.reason ? ' — ' + esc(e.reason) : ''}${ev?.best ? `<br><span class="muted">best challenger: ${esc(ev.best.change)} · ΔBrier ${f(ev.best.delta, 6)} · ${ev.tested} tested on ${ev.n} held-out bars</span>` : ''}`;
    case 'adopt': return `<span class="tag adopt">adopt</span>v${e.version}: ${esc(e.change)}<br><span class="muted">ΔBrier ${f(ev?.best?.delta, 6)}, DM p=${f(ev?.best?.dmP, 5)} &lt; ${f(ev?.best?.alphaCorrected, 5)}</span>`;
    case 'shrink': return `<span class="tag shrink">shrink</span>confidence factor ${f(e.from, 2)} → ${f(e.to, 2)} <span class="muted">(n=${e.evidence?.n}, raw optimum ${f(e.evidence?.rawLambda, 2)})</span>`;
    case 'shrink-review': return `<span class="tag">shrink</span>kept ${f(e.current, 2)} (suggested ${f(e.suggested, 2)}, n=${e.n})`;
    case 'rollback-check': return `<span class="tag">verify</span>${e.enough ? `live ${f(e.liveBrier, 5)} vs previous model ${f(e.prevBrier, 5)} over ${e.n} → ${e.rollback ? 'ROLLBACK' : 'keep current'}` : `waiting for evidence (${e.n} live forecasts since adoption)`}`;
    case 'rollback': return `<span class="tag rollback">rollback</span>reverted v${e.from_version} → v${e.to_version}`;
    case 'alarm': return `<span class="tag alarm">alarm</span>live Brier worse than climatology by ${f(e.dbar, 5)} (p=${f(e.p, 3)}); early search triggered`;
    default: return `<span class="tag">${esc(e.type)}</span>`;
  }
}
function renderAgent() {
  const A = summary?.agent, P = summary?.config?.params;
  if (!summary || !P) { $('agentStatus').innerHTML = '<tr><td class="muted">No data published yet.</td></tr>'; return; }
  const st = A?.state || {};
  const ago = (t) => (t ? stamp(t) : 'never');
  $('agentStatus').innerHTML = [
    ['Champion version', 'v' + P.version], ['Previous (rollback target)', A?.previousVersion ? 'v' + A.previousVersion : 'none'],
    ['Confidence factor λ', f(P.shrink, 2) + (P.shrink < 0.2 ? ' — forecasts pulled toward 50% (no proven skill)' : '')],
    ['Last full review', ago(st.lastDeepTs)], ['Last adoption', ago(st.lastAdoptTs)],
    ['Review cadence', 'every 6 h, or 1 h after a degradation alarm'],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  const keys = ['volLambda', 'driftLambda', 'baseLambda', 'lrLogit', 'l2Logit', 'lrShort', 'l2Short', 'hedgeEta', 'fixedShare', 'plattLr', 'kLambda', 'kurtLambda'];
  $('paramTable').innerHTML = keys.map((k) => `<tr><th>${k}</th><td>${Number(P[k]).toPrecision(4)}</td></tr>`).join('') + `<tr><th>features</th><td>${esc(P.features.join(', '))}</td></tr>`;
  const S = summary.model_state;
  if (S) {
    const rows = [['Ensemble weights', ['base', 'logit', 'drift', 'short'].map((n, i) => `${n} ${(S.weights[i] * 100).toFixed(1)}%`).join(' · ')],
      ['Platt a, b', `${f(S.a, 4)}, ${f(S.b, 4)}`], ['Student-t ν (live)', f(Math.min(30, Math.max(3.5, S.m4 / (S.m2 * S.m2) > 3.3 ? 4 + 6 / (S.m4 / (S.m2 * S.m2) - 3) : 30)), 1)],
      ['Variance ratio m₂', f(S.m2, 3)], ['Base rate P(up)', pct(S.base, 2)]];
    S.features.forEach((n, i) => rows.push([`logit coef · ${n}`, f(S.w1[i], 4)]));
    rows.push(['logit coef · bias', f(S.w1[S.features.length], 4)]);
    $('stateTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  } else $('stateTable').innerHTML = '<tr><td class="muted">Published with the next forecast.</td></tr>';
  const ev = A?.events || [];
  $('agentLog').innerHTML = ev.length ? ev.map((e) => `<div><span class="t">${esc(e.ts ? new Date(e.ts).toLocaleString() : '')}</span>${describeEvent(e)}</div>`).join('') : '<div class="muted">No decisions logged yet.</div>';
}
function renderIntegrity() {
  if (!summary) { $('intTable').innerHTML = '<tr><td class="muted">No data published yet.</td></tr>'; return; }
  const H = summary.health || {}, C = summary.counts || {}, X = H.cross_check;
  const rows = [
    ['Ledger events', `${(H.ledger?.seq ?? 0).toLocaleString()} · chain ${H.ledger?.ok ? '<span class="up">verified</span>' : '<span class="down">BROKEN</span>'}`],
    ['Head hash', `<code title="${esc(H.ledger?.head || '')}">${esc((H.ledger?.head || '').slice(0, 20))}…</code>`],
    ['Forecasts / scored / pending', `${C.forecasts} / ${C.resolved} / ${C.pending}`],
    ['Skipped bars (runner late) / voids / exact ties', `${C.gaps} / ${C.voids} / ${C.ties}`],
    ['Bars loaded / gap-filled', `${H.bars_loaded} / ${H.bars_filled}`],
    ['Cross-venue check', X ? `Coinbase ${usd(X.coinbase)} · Kraken ${usd(X.kraken)} · Bitstamp ${usd(X.bitstamp)} · divergence ${f(X.divergencePct, 3)}%` : 'n/a'],
    ['Scoreboard generated', new Date(summary.generated_at).toLocaleString()],
    ['Code revision', H.commit ? `<code>${esc(String(H.commit).slice(0, 10))}</code>` : '—'],
  ];
  if (REPO_URL) rows.push(['Repository', `<a href="${REPO_URL}" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}</a> · <a href="${REPO_URL}/tree/data" target="_blank" rel="noopener">ledger branch</a>`]);
  $('intTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
}

/* ---------------- download all source files ---------------- */
async function fetchText(path) {
  const tryUrl = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); };
  try { return await tryUrl(path); } catch { if (RAW_MAIN) return tryUrl(RAW_MAIN + path); throw new Error('not found'); }
}
async function downloadZip() {
  const btn = $('dl'), st = $('dlStatus');
  btn.disabled = true;
  try {
    if (!window.JSZip) throw new Error('zip library failed to load (check your connection)');
    const manifest = await (await fetch('manifest.json', { cache: 'no-store' })).json();
    const zip = new window.JSZip(), missing = [];
    let k = 0;
    for (const p of manifest.files) {
      st.textContent = `adding ${++k}/${manifest.files.length}: ${p}`;
      try { zip.file('xrp-forecast/' + p, await fetchText(p)); } catch { missing.push(p); }
    }
    if ($('incData').checked && summary) {
      const extra = ['summary.json', 'config.json', 'head.json', ...(summary.ledger_files || []).map((n) => 'ledger/' + n)];
      for (const p of extra) {
        st.textContent = 'adding data: ' + p;
        try { const r = await fetch(DATA_BASE + p, { cache: 'no-store' }); if (!r.ok) throw 0; zip.file('xrp-forecast/data/' + p, await r.arrayBuffer()); } catch { missing.push('data/' + p); }
      }
    }
    if (missing.length) zip.file('xrp-forecast/MISSING.txt', 'Could not be fetched from this host:\n' + missing.join('\n') + '\n');
    st.textContent = 'compressing…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'xrp-forecast-source.zip'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    st.textContent = missing.length ? `done (${missing.length} file(s) unavailable, listed in MISSING.txt)` : 'done';
  } catch (e) { st.innerHTML = `<span class="down">${esc(e.message || e)}</span>`; }
  btn.disabled = false;
}

/* ---------------- 4-agent operational dashboard ---------------- */
const AGENT_TAG_CLASS = { adopt: 'up', reject: 'muted', recover: 'warn', alarm: 'down', info: 'muted' };
async function loadAgents4() {
  const logEl = $('agentLog4');
  if (!logEl) return;
  try {
    const base = RAW_MAIN || './';
    const link = $('agentLogLink');
    if (link) link.href = base + 'data/agent_log.jsonl';
    const lines = (await (await fetch(base + 'data/agent_log.jsonl?t=' + Date.now(), { cache: 'no-store' })).text()).trim().split('\n').filter(Boolean);
    const evs = lines.map((l) => JSON.parse(l)).reverse();
    logEl.innerHTML = '';
    evs.slice(0, 30).forEach((e) => {
      const d = document.createElement('div');
      const t = e.ts ? new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const tagCls = AGENT_TAG_CLASS[e.tag] || 'muted';
      d.innerHTML = `<span class="t">${esc(t)}</span><span class="tag ${esc(e.tag || '')}">${esc(e.agent || '')}</span>` +
        `<span class="${tagCls}">${esc(e.decision || '')}</span><br><span class="muted" style="font-size:12px">${esc(e.detail || '')}</span>`;
      logEl.appendChild(d);
    });
    // health from latest events + live data
    const last = {};
    evs.forEach((e) => { if (e.agent && !last[e.agent]) last[e.agent] = e.ts; });
    const ago = (ts) => {
      if (!ts) return '—';
      const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
      return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
    };
    const set = (id, txt, sub, ok) => {
      const e = $(id); if (!e) return;
      e.textContent = txt; e.className = 'v ' + (ok === false ? 'warn' : ok === true ? 'up' : '');
      const s = $(id + '_t'); if (s) s.textContent = sub || '';
    };
    try {
      const sj = await (await fetch(DATA_BASE + 'summary.json?m=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })).json();
      const genAge = sj.generated_at ? (Date.now() - new Date(sj.generated_at).getTime()) / 60000 : 999;
      set('h4_fc', genAge < 15 ? '● live' : '● stale', 'forecast ' + ago(sj.generated_at), genAge < 15);
    } catch { set('h4_fc', '● ?', '', null); }
    set('h4_sc', last.scorer ? '● live' : '● armed', last.scorer ? 'last run ' + ago(last.scorer) : 'runs every 15 min', !!last.scorer);
    set('h4_rt', last.retrainer ? '● armed' : '● armed', last.retrainer ? 'last run ' + ago(last.retrainer) : 'runs Sundays', true);
    set('h4_rs', last.researcher ? '● armed' : '● armed', last.researcher ? 'last scan ' + ago(last.researcher) : 'runs Mondays', true);
  } catch {
    logEl.innerHTML = '<div class="empty">Agent log unavailable.</div>';
  }
}

/* ---------------- CF Benchmarks live reference-rate panel (additive) ---------------- */
let cfRate = null;
function vwmJS(pairs) {
  if (!pairs.length) return null;
  const s = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = s.reduce((a, t) => a + t[1], 0);
  if (total <= 0) return null;
  let cum = 0;
  for (const [p, v] of s) { cum += v; if (cum >= total / 2) return p; }
  return s[s.length - 1][0];
}
async function loadCFRate() {
  try {
    const r = await fetch(DATA_BASE + 'cf-rate.json?m=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
    if (!r.ok) throw 0;
    cfRate = await r.json();
    renderCFRate();
  } catch { /* keep previous values on screen */ }
}
function renderCFRate(liveVal, liveAgeS, liveNote) {
  if (!cfRate || !$('cfLive')) return;
  const d = cfRate;
  if (d.official_rr && d.official_rr.value) {
    $('cfRR').textContent = '$' + d.official_rr.value.toFixed(5);
    const pub = new Date(d.official_rr.published);
    $('cfRRTime').textContent = 'published ' + pub.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · 16:00 London fixing';
  }
  const v = liveVal != null ? liveVal : d.live_rate;
  $('cfLive').textContent = v ? '$' + v.toFixed(5) : '—';
  const ageS = liveAgeS != null ? liveAgeS : Math.max(0, Math.round((Date.now() - Date.parse(d.computed_at)) / 1000));
  const ageTxt = ageS < 90 ? ageS + 's ago' : Math.round(ageS / 60) + 'm ago';
  $('cfLiveAge').textContent = 'recomputed ' + ageTxt + (liveNote ? ' · ' + liveNote : ' · server, ' + (d.venues_used || '?') + ' venues');
  if (d.trade_count) $('cfTrades').textContent = d.trade_count.toLocaleString();
}
async function tickCFLive() {
  // Recompute the current partial 5-minute partition live in the browser from
  // Coinbase + Bitstamp public trades (the two venues whose APIs allow browser
  // fetch), blended with the server's finalized partitions (4 venues).
  if (!cfRate || !cfRate.partitions || !cfRate.partitions.length) return;
  try {
    const pStart = Math.floor(Date.now() / 300000) * 300000;
    const [cb, bs] = await Promise.all([
      fetch('https://api.exchange.coinbase.com/products/XRP-USD/trades?limit=100').then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('https://www.bitstamp.net/api/v2/transactions/xrpusd/').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    const trades = [];
    for (const t of cb || []) { const ms = Date.parse(t.time); if (ms >= pStart) trades.push([parseFloat(t.price), parseFloat(t.size)]); }
    for (const t of bs || []) { const ms = parseInt(t.date, 10) * 1000; if (ms >= pStart) trades.push([parseFloat(t.price), parseFloat(t.amount)]); }
    const finalized = cfRate.partitions.filter((p) => p.t1 <= pStart && p.vwm != null).slice(-11);
    const vwms = finalized.map((p) => p.vwm);
    const cur = vwmJS(trades);
    if (cur != null) vwms.push(cur);
    else { const lp = cfRate.partitions[cfRate.partitions.length - 1]; if (lp && lp.vwm != null) vwms.push(lp.vwm); }
    if (!vwms.length) return;
    const live = vwms.reduce((a, b) => a + b, 0) / vwms.length;
    renderCFRate(live, 0, 'live in your browser · Coinbase + Bitstamp');
  } catch { /* keep server value on screen */ }
}

/* ---------------- boot ---------------- */
document.querySelectorAll('#winTabs button').forEach((b) => b.addEventListener('click', () => renderScore(b.dataset.w)));
$('dl').addEventListener('click', downloadZip);
$('zin').addEventListener('click', () => zoomBy(1 / 1.6));
$('zout').addEventListener('click', () => zoomBy(1.6));
$('zfit').addEventListener('click', () => setZoom(null));
$('chart').addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.25 : 1 / 1.25); }, { passive: false });
window.addEventListener('resize', () => { schedDraw(); renderScore(currentWin); });
window.addEventListener('load', () => {
  if (window.renderMathInElement) {
    window.renderMathInElement($('method'), { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false });
  }
});
(async function boot() {
  await resolveBases();
  loadCandles(); connectWS();
  await loadSummary();
  runBacktest();
  loadAgents4();
  loadCFRate();
  tickCountdown();
  setInterval(tickCountdown, 1000);
  setInterval(pollTicker, 5000);
  setInterval(loadCandles, 60000);
  setInterval(loadSummary, 60000);
  setInterval(loadAgents4, 300000);
  setInterval(loadCFRate, 60000);
  setInterval(tickCFLive, 10000);
  setInterval(schedDraw, 5000);
})();
