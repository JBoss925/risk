/**
 * Risk — Zero-cost Cloudflare Worker CORS Proxy for Static Deployment
 * Deploy with: `wrangler deploy worker/cloudflare-worker.js`
 * Then set Proxy URL in Risk -> Paper Desk / Settings -> Market Data Proxy.
 */
const VALID_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]);
const VALID_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"]);

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/market/chart") {
      const symbol = (url.searchParams.get("symbol") || "NVDA").trim().toUpperCase();
      const range = VALID_RANGES.has(url.searchParams.get("range")) ? url.searchParams.get("range") : "1y";
      const interval = VALID_INTERVALS.has(url.searchParams.get("interval"))
        ? url.searchParams.get("interval")
        : "1d";

      if (!/^[A-Z0-9.\-^=]{1,16}$/.test(symbol)) {
        return new Response(JSON.stringify({ error: "Invalid ticker" }), { status: 400, headers: cors });
      }

      const upstream = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        symbol
      )}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;

      const res = await fetch(upstream, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        cf: { cacheTtl: interval.endsWith("m") ? 15 : 60, cacheEverything: true },
      });

      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) {
        return new Response(JSON.stringify({ error: "Symbol not found" }), { status: 404, headers: cors });
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
        const factor = adjClose && Number.isFinite(adjClose[i]) && c > 0 ? adjClose[i] / c : 1;
        bars.push({ t: timestamps[i] * 1000, o: o * factor, h: h * factor, l: l * factor, c: c * factor, v });
      }
      return new Response(
        JSON.stringify({
          symbol: meta.symbol || symbol,
          name: meta.longName || meta.shortName || symbol,
          exchange: meta.exchangeName || "",
          currency: meta.currency || "USD",
          regularMarketPrice: meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : 0),
          regularMarketTime: (meta.regularMarketTime || 0) * 1000,
          interval,
          range,
          source: "cloudflare-edge (live)",
          fetchedAt: Date.now(),
          bars,
        }),
        { status: 200, headers: cors }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
  },
};
