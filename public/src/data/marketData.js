// Market Data Layer: Yahoo Proxy + Alpaca BYOK REST/WebSocket + IndexedDB Cache + Offline Fallback

const DB_NAME = "risk_market_cache_v1";
const STORE_NAME = "bars";
const SETTINGS_KEY = "risk_data_settings_v1";

export function loadDataSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { proxyBase: "", alpacaKey: "", alpacaSecret: "", alpacaFeed: "iex", ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { proxyBase: "", alpacaKey: "", alpacaSecret: "", alpacaFeed: "iex" };
}

export function saveDataSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedSeries(key, maxAgeMs) {
  try {
    const db = await openCacheDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec && Date.now() - rec.savedAt < maxAgeMs) resolve(rec.payload);
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedSeries(key, payload) {
  try {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ key, savedAt: Date.now(), payload });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

export function getBarsPerYear(interval) {
  switch (interval) {
    case "5m": return 252 * 78;
    case "15m": return 252 * 26;
    case "1h": return 252 * 6.5;
    case "1wk": return 52;
    case "1mo": return 12;
    default: return 252;
  }
}

// Map UI range/interval to valid Yahoo Finance combos
export function normalizeRangeForInterval(range, interval) {
  if (interval === "5m" || interval === "15m") {
    if (!["1d", "5d", "1mo"].includes(range)) return "1mo";
  }
  if (interval === "1h") {
    if (!["5d", "1mo", "3mo", "6mo", "1y", "2y"].includes(range)) return "6mo";
  }
  return range;
}

// Direct Browser BYOK Alpaca Historical Fetch
async function fetchFromAlpaca(symbol, range, interval, settings) {
  const tfMap = { "5m": "5Min", "15m": "15Min", "1h": "1Hour", "1d": "1Day", "1wk": "1Week" };
  const daysMap = { "5d": 7, "1mo": 32, "3mo": 95, "6mo": 185, "1y": 370, "2y": 740, "5y": 1830, max: 2550 };
  const tf = tfMap[interval] || "1Day";
  const days = daysMap[range] || 370;
  const start = new Date(Date.now() - days * 86400_000).toISOString();
  const feed = settings.alpacaFeed || "iex";

  const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(
    symbol
  )}/bars?timeframe=${tf}&start=${encodeURIComponent(start)}&limit=10000&adjustment=all&feed=${feed}`;

  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": settings.alpacaKey.trim(),
      "APCA-API-SECRET-KEY": settings.alpacaSecret.trim(),
    },
  });
  if (!res.ok) {
    throw new Error(`Alpaca HTTP ${res.status}`);
  }
  const data = await res.json();
  const bars = (data.bars || []).map((b) => ({
    t: Date.parse(b.t),
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
  if (!bars.length) throw new Error("Alpaca returned 0 bars");

  return {
    symbol,
    name: symbol,
    exchange: feed.toUpperCase(),
    currency: "USD",
    regularMarketPrice: bars[bars.length - 1].c,
    regularMarketTime: bars[bars.length - 1].t,
    interval,
    range,
    source: `alpaca-${feed} (BYOK live)`,
    fetchedAt: Date.now(),
    bars,
  };
}

// Deterministic realistic fallback market generator (used only if network & proxy are unreachable)
function generateFallbackMarket(symbol, range, interval) {
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  const gauss = () => {
    const u1 = Math.max(1e-6, rand());
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const countMap = { "1mo": 120, "3mo": 90, "6mo": 140, "1y": 252, "2y": 504, "5y": 1000, max: 1200 };
  const n = countMap[range] || 252;
  const stepMs =
    interval === "5m" ? 300_000 : interval === "15m" ? 900_000 : interval === "1h" ? 3_600_000 : interval === "1wk" ? 604_800_000 : 86_400_000;

  const basePrices = { NVDA: 138, AAPL: 228, SPY: 588, MSFT: 424, TSLA: 312, META: 582, AMD: 152, QQQ: 505, "BTC-USD": 89500 };
  const targetEnd = basePrices[symbol] || 80 + (seed % 320);
  const vol = interval === "1d" ? 0.019 : interval === "1h" ? 0.007 : 0.004;

  // Build path with regime shifts (trending + pullbacks + breakouts) so indicators behave naturally
  const closes = [100];
  let regimeDrift = 0.0005;
  for (let i = 1; i < n; i++) {
    if (i % 38 === 0) regimeDrift = (rand() - 0.45) * 0.0038;
    const shock = gauss() * vol + regimeDrift;
    closes.push(Math.max(5, closes[i - 1] * Math.exp(shock)));
  }
  const scale = targetEnd / closes[n - 1];
  const now = Date.now();
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = closes[i] * scale;
    const prev = (i > 0 ? closes[i - 1] : closes[0]) * scale;
    const o = prev * (1 + gauss() * vol * 0.25);
    const wickUp = Math.abs(gauss()) * vol * 0.65;
    const wickDn = Math.abs(gauss()) * vol * 0.65;
    const h = Math.max(o, c) * (1 + wickUp);
    const l = Math.min(o, c) * (1 - wickDn);
    const v = Math.round((8e6 + rand() * 3.2e7) * (1 + Math.abs(c - o) / Math.max(1e-6, o) * 18));
    bars.push({
      t: now - (n - 1 - i) * stepMs,
      o,
      h,
      l,
      c,
      v,
    });
  }

  return {
    symbol,
    name: `${symbol} (Offline Synthetic)`,
    exchange: "SIM",
    currency: "USD",
    regularMarketPrice: bars[bars.length - 1].c,
    regularMarketTime: bars[bars.length - 1].t,
    interval,
    range,
    source: "offline-synthetic",
    fetchedAt: Date.now(),
    bars,
  };
}

export async function fetchMarketData(symbol, range = "1y", interval = "1d", { forceRefresh = false } = {}) {
  const sym = symbol.trim().toUpperCase();
  const effRange = normalizeRangeForInterval(range, interval);
  const settings = loadDataSettings();
  const cacheKey = `${sym}|${effRange}|${interval}|${settings.alpacaKey ? "alp" : "yh"}`;
  const ttlMs = interval.endsWith("m") || interval === "1h" ? 20_000 : 120_000;

  if (!forceRefresh) {
    const cached = await getCachedSeries(cacheKey, ttlMs);
    if (cached && cached.bars?.length > 20) {
      return { ...cached, fromIndexedDB: true };
    }
  }

  // 1. If user supplied Alpaca BYOK keys (and equity ticker without '-'), try Alpaca first
  if (settings.alpacaKey && settings.alpacaSecret && !sym.includes("-") && !sym.startsWith("^")) {
    try {
      const alp = await fetchFromAlpaca(sym, effRange, interval, settings);
      await setCachedSeries(cacheKey, alp);
      return alp;
    } catch (err) {
      console.warn("[Risk] Alpaca BYOK fetch failed, falling back to proxy:", err.message);
    }
  }

  // 2. Local / Edge Yahoo Finance proxy
  const base = (settings.proxyBase || "").replace(/\/$/, "");
  const proxyUrl = `${base}/api/market/chart?symbol=${encodeURIComponent(sym)}&range=${encodeURIComponent(
    effRange
  )}&interval=${encodeURIComponent(interval)}`;

  try {
    const res = await fetch(proxyUrl);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (!payload.bars || payload.bars.length < 10) {
      throw new Error("Insufficient historical bars returned");
    }
    await setCachedSeries(cacheKey, payload);
    return payload;
  } catch (err) {
    console.warn("[Risk] Proxy fetch failed, using offline fallback:", err.message);
    const fallback = generateFallbackMarket(sym, effRange, interval);
    fallback.warning = `Live feed unavailable (${err.message}); showing synthetic series.`;
    return fallback;
  }
}

export async function searchSymbols(query) {
  const q = query.trim();
  if (!q) return [];
  const settings = loadDataSettings();
  const base = (settings.proxyBase || "").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/market/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.quotes || [];
  } catch {
    return [];
  }
}

// Live Alpaca IEX WebSocket connector (Direct Browser BYOK — bypasses CORS)
export class AlpacaLiveStream {
  constructor({ onTick, onStatus }) {
    this.ws = null;
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.symbol = null;
  }

  connect(symbol, key, secret, feed = "iex") {
    this.disconnect();
    if (!key || !secret) return;
    this.symbol = symbol;
    const url = `wss://stream.data.alpaca.markets/v2/${feed}`;
    this.onStatus?.("connecting");
    try {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ action: "auth", key: key.trim(), secret: secret.trim() }));
      };
      this.ws.onmessage = (ev) => {
        const msgs = JSON.parse(ev.data);
        for (const m of msgs) {
          if (m.T === "success" && m.msg === "authenticated") {
            this.ws.send(JSON.stringify({ action: "subscribe", trades: [symbol], bars: [symbol] }));
            this.onStatus?.("live");
          } else if (m.T === "t" && m.S === symbol) {
            this.onTick?.({ price: m.p, size: m.s, time: Date.parse(m.t) || Date.now() });
          } else if (m.T === "error") {
            this.onStatus?.(`error: ${m.msg}`);
          }
        }
      };
      this.ws.onerror = () => this.onStatus?.("error");
      this.ws.onclose = () => this.onStatus?.("disconnected");
    } catch (e) {
      this.onStatus?.(`error: ${e.message}`);
    }
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.onStatus?.("idle");
  }
}
