// Netlify Functions v2 catch-all CORS proxy for Yahoo Finance market bars & symbol search.
// All quantitative computation, indicators, WASM backtesting, forecasting, simulation,
// and paper trading run 100% locally in the user's browser.

const VALID_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]);
const VALID_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"]);

const apiCache = new Map();
const DEFAULT_TTL_MS = 30_000;

async function fetchJsonCached(cacheKey, urls, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const hit = apiCache.get(cacheKey);
  if (hit && now - hit.ts < ttlMs) {
    return { data: hit.data, cached: true };
  }
  let lastErr = null;
  for (const url of urls) {
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
      if (apiCache.size > 150) {
        for (const [k, v] of apiCache) {
          if (now - v.ts > ttlMs * 4) apiCache.delete(k);
        }
      }
      return { data, cached: false };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All upstream market endpoints failed");
}

function jsonResponse(status, obj, cdnTtlSec = 0) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
  if (cdnTtlSec > 0) {
    headers["Netlify-CDN-Cache-Control"] = `public, s-maxage=${cdnTtlSec}, stale-while-revalidate=${cdnTtlSec * 2}`;
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const urlObj = new URL(req.url);
  const pathname = urlObj.pathname;

  if (pathname === "/api/health") {
    return jsonResponse(200, { ok: true, server: "risk-netlify-fn", time: Date.now() });
  }

  if (pathname === "/api/market/chart") {
    const symbol = (urlObj.searchParams.get("symbol") || "NVDA").trim().toUpperCase();
    const range = (urlObj.searchParams.get("range") || "1y").trim();
    const interval = (urlObj.searchParams.get("interval") || "1d").trim();

    if (!/^[A-Z0-9.\-^=]{1,16}$/.test(symbol)) {
      return jsonResponse(400, { error: "Invalid ticker symbol" });
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
      const intraday = safeInterval.endsWith("m") || safeInterval === "1h";
      const ttlMs = intraday ? 15_000 : 45_000;
      const { data, cached } = await fetchJsonCached(`${symbol}|${safeRange}|${safeInterval}`, upstream, ttlMs);
      const result = data?.chart?.result?.[0];
      if (!result) {
        const errMsg = data?.chart?.error?.description || "Symbol not found";
        return jsonResponse(404, { error: errMsg });
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

      return jsonResponse(
        200,
        {
          symbol: meta.symbol || symbol,
          name: meta.longName || meta.shortName || symbol,
          exchange: meta.exchangeName || meta.fullExchangeName || "",
          currency: meta.currency || "USD",
          regularMarketPrice: meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : 0),
          regularMarketTime: (meta.regularMarketTime || 0) * 1000,
          chartPreviousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
          interval: safeInterval,
          range: safeRange,
          source: cached ? "yahoo-edge (cached)" : "yahoo-edge (live)",
          fetchedAt: Date.now(),
          bars,
        },
        intraday ? 15 : 45
      );
    } catch (err) {
      return jsonResponse(502, { error: String(err.message || err) });
    }
  }

  if (pathname === "/api/market/search") {
    const q = (urlObj.searchParams.get("q") || "").trim();
    if (!q || q.length > 40) return jsonResponse(200, { quotes: [] });
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
      return jsonResponse(200, { quotes }, 120);
    } catch (err) {
      return jsonResponse(502, { error: String(err.message || err), quotes: [] });
    }
  }

  return jsonResponse(404, { error: "Unknown API route" });
}

export const config = {
  path: "/api/*",
};
