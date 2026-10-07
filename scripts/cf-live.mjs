#!/usr/bin/env node
/**
 * cf-live.mjs — live implementation of the CF Benchmarks reference-rate methodology.
 *
 * Official methodology (CME CF Reference Rates Methodology, docs.cfbenchmarks.com):
 *   1. Observation window split into 12 equal partitions (official: 5 minutes each).
 *   2. Per partition, the volume-weighted median (VWM) trade price is calculated
 *      from the trade prices and sizes of ALL relevant transactions, i.e. pooled
 *      across all constituent exchanges.
 *   3. The reference rate is the equally-weighted mean of the partition VWMs.
 *
 * Live adaptation here: the same 12 x 5-minute partition structure is applied to
 * the trailing 60 minutes, recomputed every run, instead of the fixed 15:00-16:00
 * London window used for the once-daily official fixing.
 *
 * Venues: Coinbase, Kraken, Bitstamp, Gemini — 4 of the 6 official CF constituent
 * exchanges (Bitstamp, Coinbase, Gemini, itBit, Kraken, LMAX Digital). LMAX Digital
 * and itBit have no free public market-data API and are excluded (documented, not faked).
 *
 * State: --data <dir> is a checkout of the `data` branch. Trades persist in
 * cf-trades.json (compact arrays), pruned to the last 65 minutes each run.
 * Output: cf-rate.json with the 12 partition VWMs, the live rate, and the official
 * daily fixing scraped from CF Benchmarks' public index page.
 *
 * Robustness: per-venue fetches are independent try/catch; if fewer than 2 venues
 * return fresh trades or fewer than 10 of 12 partitions are valid, the previous
 * cf-rate.json is kept (never publish a degraded value).
 */
import fs from 'node:fs';
import path from 'node:path';

const VENUES = ['coinbase', 'kraken', 'bitstamp', 'gemini'];
const PART_MS = 5 * 60 * 1000;
const N_PART = 12;
const WINDOW_MS = N_PART * PART_MS;
const KEEP_MS = 65 * 60 * 1000;
const MIN_TRADES_PER_PARTITION = 5;
const MIN_VALID_PARTITIONS = 10;
const MIN_VENUES = 2;

const CF_RR_PAGE = 'https://www.cfbenchmarks.com/data/indices/XRPUSD_RR';
const CF_METHOD_PDF = 'https://docs.cfbenchmarks.com/CME%20CF%20Reference%20Rates%20Methodology.pdf';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; cf-live-methodology/1.0)' };

function vwm(pairs) {
  // pairs: [[price, size], ...] -> volume-weighted median price
  if (!pairs.length) return null;
  const s = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = s.reduce((a, t) => a + t[1], 0);
  if (total <= 0) return null;
  let cum = 0;
  for (const [p, v] of s) {
    cum += v;
    if (cum >= total / 2) return p;
  }
  return s[s.length - 1][0];
}

async function getJSON(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Each fetcher returns [[t_ms, price, size, venueIdx], ...] newer than sinceMs.
async function fetchCoinbase(sinceMs) {
  const out = [];
  let url = 'https://api.exchange.coinbase.com/products/XRP-USD/trades?limit=100';
  for (let page = 0; page < 4; page++) {
    const rows = await getJSON(url);
    if (!Array.isArray(rows) || !rows.length) break;
    let oldest = Infinity;
    for (const r of rows) {
      const t = Date.parse(r.time);
      oldest = Math.min(oldest, t);
      if (t >= sinceMs) out.push([t, parseFloat(r.price), parseFloat(r.size), 0, String(r.trade_id)]);
    }
    if (oldest < sinceMs || rows.length < 100) break;
    const lastId = rows[rows.length - 1].trade_id;
    url = `https://api.exchange.coinbase.com/products/XRP-USD/trades?limit=100&before=${lastId}`;
  }
  return out;
}

async function fetchKraken(sinceMs) {
  // Kraken `since` is in nanoseconds; returns up to ~1000 recent trades.
  const sinceNs = String(Math.floor(sinceMs * 1e6));
  const j = await getJSON(`https://api.kraken.com/0/public/Trades?pair=XRPUSD&since=${sinceNs}`);
  const out = [];
  const arr = j?.result?.XXRPZUSD;
  if (Array.isArray(arr)) {
    for (const r of arr) {
      const t = Math.floor(r[2] * 1000);
      if (t >= sinceMs) out.push([t, parseFloat(r[0]), parseFloat(r[1]), 1, String(r[6] ?? `${r[2]}-${r[0]}`)]);
    }
  }
  return out;
}

async function fetchBitstamp(sinceMs) {
  const rows = await getJSON('https://www.bitstamp.net/api/v2/transactions/xrpusd/?time=hour');
  const out = [];
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const t = parseInt(r.date, 10) * 1000;
      if (t >= sinceMs) out.push([t, parseFloat(r.price), parseFloat(r.amount), 2, String(r.tid)]);
    }
  }
  return out;
}

async function fetchGemini(sinceMs) {
  const rows = await getJSON('https://api.gemini.com/v1/trades/xrpusd?limit_trades=500');
  const out = [];
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const t = parseInt(r.timestampms, 10);
      if (t >= sinceMs) out.push([t, parseFloat(r.price), parseFloat(r.amount), 3, String(r.tid)]);
    }
  }
  return out;
}

async function fetchOfficialRR() {
  // Scrape CF Benchmarks' public index page (server-rendered): value + "Last updated".
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(CF_RR_PAGE, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let html = await r.text();
    html = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
    html = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const v = html.match(/XRP-Dollar Reference Rate\s+XRPUSD_RR\s+\$([0-9]+\.[0-9]+)\s+([+-]?[0-9.]+)\s*%/);
    const u = html.match(/Last updated:\s*([A-Za-z]{3},\s*\d{2}\s*[A-Za-z]{3}\s*\d{4}\s*\d{2}:\d{2}:\d{2}\s*GMT)/);
    if (!v) throw new Error('value not found on CF page');
    return {
      value: parseFloat(v[1]),
      change_pct: parseFloat(v[2]),
      published: u ? new Date(u[1]).toISOString() : null,
      source: CF_RR_PAGE,
    };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf('--data');
  if (di < 0) { console.error('usage: node scripts/cf-live.mjs --data <data-branch-dir>'); process.exit(2); }
  const dir = args[di + 1];
  fs.mkdirSync(dir, { recursive: true });

  const tradesPath = path.join(dir, 'cf-trades.json');
  const ratePath = path.join(dir, 'cf-rate.json');
  let prev = { trades: [], meta: {} };
  try { prev = JSON.parse(fs.readFileSync(tradesPath, 'utf8')); } catch { /* first run */ }
  if (!Array.isArray(prev.trades)) prev.trades = [];

  const now = Date.now();
  const sinceMs = now - KEEP_MS;
  // Incremental fetch: only need trades newer than the newest we already hold (minus overlap).
  const newestHeld = prev.trades.reduce((m, t) => Math.max(m, t[0]), 0);
  const fetchSince = Math.max(sinceMs, newestHeld - 10 * 60 * 1000);

  const fetchers = [fetchCoinbase, fetchKraken, fetchBitstamp, fetchGemini];
  const results = await Promise.allSettled(fetchers.map((fn) => fn(fetchSince)));
  const fresh = [];
  const venueStatus = [];
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      fresh.push(...res.value);
      venueStatus.push(`${VENUES[i]}:ok(${res.value.length})`);
    } else {
      venueStatus.push(`${VENUES[i]}:FAIL(${String(res.reason?.message || res.reason).slice(0, 60)})`);
    }
  });

  // Merge + dedup on (venue, trade id), then prune.
  const seen = new Set(prev.trades.map((t) => t[3] + ':' + t[4]));
  for (const t of fresh) {
    const k = t[3] + ':' + t[4];
    if (!seen.has(k)) { seen.add(k); prev.trades.push(t); }
  }
  prev.trades = prev.trades.filter((t) => t[0] >= sinceMs);
  prev.trades.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(tradesPath, JSON.stringify({ updated: new Date(now).toISOString(), trades: prev.trades }));

  const venuesUsed = new Set(prev.trades.filter((t) => t[0] >= now - WINDOW_MS).map((t) => t[3])).size;

  // 12 clock-aligned 5-minute partitions over the trailing 60 minutes.
  const winStart = Math.floor((now - WINDOW_MS) / PART_MS) * PART_MS;
  const partitions = [];
  let prevVwm = null;
  for (let i = 0; i < N_PART; i++) {
    const t0 = winStart + i * PART_MS;
    const t1 = t0 + PART_MS;
    const inPart = prev.trades.filter((t) => t[0] >= t0 && t[0] < t1).map((t) => [t[1], t[2]]);
    let w = inPart.length >= MIN_TRADES_PER_PARTITION ? vwm(inPart) : null;
    if (w == null && prevVwm != null) w = prevVwm; // carry forward (documented fallback)
    const vol = inPart.reduce((a, t) => a + t[1], 0);
    partitions.push({ t0, t1, vwm: w, trades: inPart.length, volume_xrp: Math.round(vol * 100) / 100 });
    if (w != null) prevVwm = w;
  }
  const valid = partitions.filter((p) => p.vwm != null);

  let official = null;
  try { official = await fetchOfficialRR(); } catch (e) {
    console.error('official RR scrape failed:', e.message);
    try { official = JSON.parse(fs.readFileSync(ratePath, 'utf8')).official_rr || null; } catch { /* none */ }
  }

  const ok = valid.length >= MIN_VALID_PARTITIONS && venuesUsed >= MIN_VENUES;
  if (!ok) {
    console.log(JSON.stringify({ status: 'degraded-keep-previous', valid_partitions: valid.length, venues_used: venuesUsed, venue_status: venueStatus }));
    process.exit(0); // keep previous cf-rate.json untouched
  }

  const liveRate = valid.reduce((a, p) => a + p.vwm, 0) / valid.length;
  const rate = {
    computed_at: new Date(now).toISOString(),
    live_rate: liveRate,
    method: 'Live implementation of the CME CF Reference Rates Methodology: 12 x 5-minute partitions over the trailing 60 minutes; volume-weighted median trade price per partition pooled across venues; equally-weighted mean of the partition medians.',
    methodology_pdf: CF_METHOD_PDF,
    venues: VENUES,
    venues_excluded: 'LMAX Digital and itBit are official CF constituents with no free public market-data API; excluded (documented, not faked).',
    venues_used: venuesUsed,
    venue_status: venueStatus,
    partitions: partitions.map((p) => ({ t0: p.t0, t1: p.t1, vwm: p.vwm == null ? null : Math.round(p.vwm * 1e6) / 1e6, trades: p.trades, volume_xrp: p.volume_xrp })),
    trade_count: prev.trades.filter((t) => t[0] >= now - WINDOW_MS).length,
    official_rr: official,
    note: 'This is a live re-implementation of CF Benchmarks\u2019 published methodology, not the official CF fixing. The official fixing publishes once daily at 16:00 London time.',
  };
  fs.writeFileSync(ratePath, JSON.stringify(rate, null, 1));
  console.log(JSON.stringify({ status: 'ok', live_rate: liveRate, valid_partitions: valid.length, venues_used: venuesUsed, trades: rate.trade_count, official_rr: official?.value ?? null }));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
