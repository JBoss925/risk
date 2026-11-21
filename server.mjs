import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 5180);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Lightweight in-memory response cache to avoid hammering upstream market APIs
const apiCache = new Map();
const CACHE_TTL_MS = 30_000;

async function fetchJsonCached(cacheKey, urls, ttlMs = CACHE_TTL_MS) {
  const now = Date.now();
  const hit = apiCache.get(cacheKey);
  if (hit && now - hit.ts < ttlMs) {
    return { data: hit.data, cached: true };
  }
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr = null;
  for (const url of list) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastErr = new Error(`Upstream HTTP ${res.status}: ${text.slice(0, 140)}`);
        continue;
      }
      const data = await res.json();
      apiCache.set(cacheKey, { ts: now, data });
      if (apiCache.size > 200) {
        for (const [k, v] of apiCache) {
          if (now - v.ts > ttlMs * 4) apiCache.delete(k);
        }
      }
      return { data, cached: false };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All upstream market endpoints failed");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const VALID_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]);
const VALID_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"]);

async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;

  if (pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, server: "risk-proxy", time: Date.now() });
  }

  if (pathname === "/api/market/chart") {
    const symbol = (urlObj.searchParams.get("symbol") || "NVDA").trim().toUpperCase();
    const range = (urlObj.searchParams.get("range") || "1y").trim();
    const interval = (urlObj.searchParams.get("interval") || "1d").trim();

    if (!/^[A-Z0-9.\-^=]{1,16}$/.test(symbol)) {
      return sendJson(res, 400, { error: "Invalid ticker symbol" });
    }
    const safeRange = VALID_RANGES.has(range) ? range : "1y";
    const safeInterval = VALID_INTERVALS.has(interval) ? interval : "1d";

    const qStr = `range=${encodeURIComponent(safeRange)}&interval=${encodeURIComponent(
      safeInterval
    )}&includePrePost=false&events=div%2Csplits`;
    const upstream = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qStr}`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qStr}`,
    ];

    try {
      const ttl = safeInterval.endsWith("m") || safeInterval === "1h" ? 15_000 : 45_000;
      const { data, cached } = await fetchJsonCached(`${symbol}|${safeRange}|${safeInterval}`, upstream, ttl);
      const result = data?.chart?.result?.[0];
      if (!result) {
        const errMsg = data?.chart?.error?.description || "Symbol not found";
        return sendJson(res, 404, { error: errMsg });
      }
      const meta = result.meta || {};
      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const adjClose = result.indicators?.adjclose?.[0]?.adjclose || null;

      const bars = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = quote.open?.[i];
        const h = quote.high?.[i];
        const l = quote.low?.[i];
        const c = quote.close?.[i];
        const v = quote.volume?.[i] ?? 0;
        if (o == null || h == null || l == null || c == null || !Number.isFinite(c)) continue;

        // Apply split/dividend adjustment factor proportionally to OHLC when daily/weekly adjclose exists
        let factor = 1;
        if (adjClose && Number.isFinite(adjClose[i]) && c > 0) {
          factor = adjClose[i] / c;
        }
        bars.push({
          t: timestamps[i] * 1000,
          o: o * factor,
          h: h * factor,
          l: l * factor,
          c: c * factor,
          v: Number.isFinite(v) ? v : 0,
        });
      }

      return sendJson(res, 200, {
        symbol: meta.symbol || symbol,
        name: meta.longName || meta.shortName || symbol,
        exchange: meta.exchangeName || meta.fullExchangeName || "",
        currency: meta.currency || "USD",
        regularMarketPrice: meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : 0),
        regularMarketTime: (meta.regularMarketTime || 0) * 1000,
        chartPreviousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        interval: safeInterval,
        range: safeRange,
        source: cached ? "yahoo-proxy (cached)" : "yahoo-proxy (live)",
        fetchedAt: Date.now(),
        bars,
      });
    } catch (err) {
      return sendJson(res, 502, { error: String(err.message || err) });
    }
  }

  if (pathname === "/api/market/search") {
    const q = (urlObj.searchParams.get("q") || "").trim();
    if (!q || q.length > 40) return sendJson(res, 200, { quotes: [] });
    const qStr = `q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false`;
    const upstream = [
      `https://query2.finance.yahoo.com/v1/finance/search?${qStr}`,
      `https://query1.finance.yahoo.com/v1/finance/search?${qStr}`,
    ];
    try {
      const { data } = await fetchJsonCached(`search|${q.toLowerCase()}`, upstream, 120_000);
      const quotes = (data?.quotes || [])
        .filter((x) => x.symbol && ["EQUITY", "ETF", "CRYPTOCURRENCY", "INDEX"].includes(x.quoteType))
        .slice(0, 8)
        .map((x) => ({
          symbol: x.symbol,
          name: x.shortname || x.longname || x.symbol,
          exchange: x.exchDisp || x.exchange || "",
          type: x.quoteType || "",
        }));
      return sendJson(res, 200, { quotes });
    } catch (err) {
      return sendJson(res, 502, { error: String(err.message || err), quotes: [] });
    }
  }

  return sendJson(res, 404, { error: "Unknown API route" });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (urlObj.pathname.startsWith("/api/")) {
      return await handleApi(req, res, urlObj);
    }

    let reqPath = decodeURIComponent(urlObj.pathname);
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }
    if (stat.isDirectory()) {
      res.writeHead(404);
      return res.end("Not Found");
    }

    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".wasm" ? "no-cache" : "no-store",
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  RISK Quant Terminal running at http://localhost:${PORT}\n  Market proxy active at /api/market/chart & /api/market/search\n`);
});
