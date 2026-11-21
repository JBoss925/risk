import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDICATOR_CATALOG } from "../public/src/data/indicators.js";
import { BUILTIN_STRATEGIES, materializeStrategy } from "../public/src/data/strategies.js";
import { PaperPortfolio } from "../public/src/data/paperStore.js";
import { SimSession } from "../public/src/data/simEngine.js";
import { computeLiveTradeRecommendation } from "../public/src/ui/tradePopup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "public", "risk-engine.wasm");

async function loadWasm() {
  const bytes = await fs.readFile(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { abort() { throw new Error("WASM abort"); } },
  });
  return instance.exports;
}

function makeSyntheticBars(n = 320) {
  const bars = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 17) * 0.015 + Math.cos(i / 7) * 0.005 + 0.0012;
    const o = px;
    const c = Math.max(10, o * (1 + wave + ((i % 5) - 2) * 0.003));
    const h = Math.max(o, c) * (1.008 + (i % 4) * 0.003);
    const l = Math.min(o, c) * (0.992 - (i % 3) * 0.003);
    const v = 10_000_000 + (i % 13) * 2_200_000;
    bars.push({ o, h, l, c, v });
    px = c;
  }
  return bars;
}

function populateBars(wasm, bars) {
  const n = bars.length;
  wasm.initBars(n);
  const o = new Float64Array(wasm.memory.buffer, wasm.getOpenPtr(), n);
  const h = new Float64Array(wasm.memory.buffer, wasm.getHighPtr(), n);
  const l = new Float64Array(wasm.memory.buffer, wasm.getLowPtr(), n);
  const c = new Float64Array(wasm.memory.buffer, wasm.getClosePtr(), n);
  const v = new Float64Array(wasm.memory.buffer, wasm.getVolumePtr(), n);
  for (let i = 0; i < n; i++) {
    o[i] = bars[i].o; h[i] = bars[i].h; l[i] = bars[i].l; c[i] = bars[i].c; v[i] = bars[i].v;
  }
  wasm.prepareBaseSeries();
}

test("All 62 WASM indicators compute finite bounded signals [-1, +1]", async () => {
  assert.equal(INDICATOR_CATALOG.length, 62);
  const wasm = await loadWasm();
  const bars = makeSyntheticBars(320);
  populateBars(wasm, bars);

  for (const item of INDICATOR_CATALOG) {
    const p = { p1: 0, p2: 0, p3: 0, p4: 0 };
    for (const param of item.params) p[param.key] = param.default;
    const lines = wasm.computeIndicator(item.id, p.p1, p.p2, p.p3, p.p4, 0);
    assert.ok(lines >= 1 && lines <= 4);
    const sig = new Float64Array(wasm.memory.buffer, wasm.getSigPtr(), bars.length);
    let nonZero = 0;
    for (let i = 0; i < sig.length; i++) {
      assert.ok(Number.isFinite(sig[i]) && sig[i] >= -1.0001 && sig[i] <= 1.0001);
      if (Math.abs(sig[i]) > 0.005) nonZero++;
    }
    if (item.key !== "mass_index") assert.ok(nonZero > 5, `Indicator ${item.key} produced ${nonZero} signals`);
  }
});

test("All 24 built-in strategies execute cleanly and compute In-Sample + 30% OOS metrics", async () => {
  assert.equal(BUILTIN_STRATEGIES.length, 24);
  const wasm = await loadWasm();
  const bars = makeSyntheticBars(320);
  populateBars(wasm, bars);

  for (const def of BUILTIN_STRATEGIES) {
    const strat = materializeStrategy(def);
    wasm.resetComposite();
    for (const rule of strat.rules) {
      wasm.computeIndicator(rule.indicatorId, rule.params.p1, rule.params.p2, rule.params.p3, rule.params.p4, rule.invert ? 1 : 0);
      wasm.accumulateRule(rule.weight, rule.mode, rule.triggerThresh, rule.vetoThresh);
    }
    wasm.finalizeComposite();
    wasm.runBacktest(strat.thresholds.buy, strat.thresholds.sell, 0, 100000, 100, 0, 0, 1, 2, 252);
    const m = new Float64Array(wasm.memory.buffer, wasm.getMetricsPtr(), 16);
    assert.ok(Number.isFinite(m[0]) && Number.isFinite(m[3]) && m[11] > 0);
    assert.ok(Number.isFinite(m[12]) && Number.isFinite(m[13]));
  }
});

test("Exact entry + exit commission accounting on flat-price Long and Short round trips", async () => {
  const wasm = await loadWasm();
  const flatBars = Array.from({ length: 12 }, () => ({ o: 100, h: 100, l: 100, c: 100, v: 1e6 }));
  populateBars(wasm, flatBars);

  // Force a single Long round trip: Buy signal at bar 1 -> fill Open bar 2; Sell signal at bar 5 -> fill Open bar 6
  const sc = new Float64Array(wasm.memory.buffer, wasm.getScorePtr(), flatBars.length);
  sc.fill(0);
  sc[1] = 50;
  sc[5] = -50;

  // 10 bps commission (0.1%), 0 slippage, 100% position size, $100,000 capital
  const longTrades = wasm.runBacktest(20, -20, 0, 100000, 100, 0, 0, 10, 0, 252);
  assert.equal(longTrades, 1);
  const trLong = new Float64Array(wasm.memory.buffer, wasm.getTradesPtr(), 8);
  const eqLong = new Float64Array(wasm.memory.buffer, wasm.getEquityPtr(), flatBars.length);
  // Entry fee = 100,000 * 0.001 = $100 -> netCap = 99,900; Exit fee = 99,900 * 0.001 = $99.90 -> total fee = $199.90
  assert.ok(Math.abs(trLong[5] - (-199.9)) < 0.01, `Long flat netPnl should be -199.90, got ${trLong[5]}`);
  assert.ok(Math.abs(eqLong[2] - 99900) < 0.01, `Equity on entry bar must deduct entry fee immediately, got ${eqLong[2]}`);
  assert.ok(Math.abs(eqLong[6] - 99800.1) < 0.01, `Final equity after Long round trip must be 99800.10, got ${eqLong[6]}`);

  // Now verify Short round trip with allowShort = 1
  sc.fill(0);
  sc[1] = -50;
  sc[5] = 50; // reverses to long, closing the short at bar 6
  const shortTrades = wasm.runBacktest(20, -20, 1, 100000, 100, 0, 0, 10, 0, 252);
  assert.equal(shortTrades, 1);
  const trShort = new Float64Array(wasm.memory.buffer, wasm.getTradesPtr(), 8);
  assert.equal(trShort[2], -1);
  assert.ok(Math.abs(trShort[5] - (-199.9)) < 0.01, `Short flat netPnl should be -199.90, got ${trShort[5]}`);
});

test("Strictly causal walk-forward forecast: bit-for-bit identical frozenPUp[t] when 100 shocked future bars are appended", async () => {
  const fullBars = makeSyntheticBars(320);
  const shocked = fullBars.map((b, i) => (i >= 220 ? { o: 10, h: 12, l: 8, c: 9, v: 9e8 } : { ...b }));

  const wasmShort = await loadWasm();
  populateBars(wasmShort, fullBars.slice(0, 220));
  wasmShort.resetComposite();
  wasmShort.computeIndicator(1, 12, 26, 0, 0, 0);
  wasmShort.accumulateRule(1.0, 0, 0.35, 0.25);
  wasmShort.finalizeComposite();
  assert.equal(wasmShort.runWalkForwardForecast(10, 0.02), 10);
  const frozenShort = new Float64Array(wasmShort.memory.buffer, wasmShort.getFrozenPUpPtr(), 220).slice();

  const wasmLong = await loadWasm();
  populateBars(wasmLong, shocked);
  wasmLong.resetComposite();
  wasmLong.computeIndicator(1, 12, 26, 0, 0, 0);
  wasmLong.accumulateRule(1.0, 0, 0.35, 0.25);
  wasmLong.finalizeComposite();
  assert.equal(wasmLong.runWalkForwardForecast(10, 0.02), 10);
  const frozenLong = new Float64Array(wasmLong.memory.buffer, wasmLong.getFrozenPUpPtr(), 320).slice();

  for (let t = 45; t < 220; t++) {
    assert.ok(
      Math.abs(frozenShort[t] - frozenLong[t]) < 1e-12,
      `Bar ${t} leaked future data: ${frozenShort[t]} vs ${frozenLong[t]}`
    );
  }
});

test("PaperPortfolio: net-of-commission realized PnL & win rate match equity delta", async () => {
  const p = new PaperPortfolio();
  p.reset(100000);
  p.setFlags({ alpacaSync: false, feeBps: 10, slippageBps: 0 });

  // Buy 100 @ $100 -> entry fee $10; Sell 100 @ $100 -> exit fee $10 -> net realized = -$20
  await p.submitMarketOrder({ symbol: "NVDA", side: "buy", qty: 100, price: 100 });
  const closeTrade = await p.submitMarketOrder({ symbol: "NVDA", side: "sell", qty: 100, price: 100 });
  const eq = p.getEquity({ NVDA: 100 });

  assert.equal(closeTrade.isClose, true);
  assert.ok(Math.abs(closeTrade.realizedPnl - (-20)) < 1e-6, `Expected -20 realized PnL, got ${closeTrade.realizedPnl}`);
  assert.ok(Math.abs(eq.realizedPnl - eq.totalPnl) < 1e-6, `Realized PnL ${eq.realizedPnl} must match totalPnl ${eq.totalPnl}`);
  assert.equal(eq.closedTotal, 1);
  assert.equal(eq.winRatePct, 0);
});

test("PaperPortfolio: Alpaca accepted order waits for fill reconciliation; network error records unknown & reconciles via client_order_id", async () => {
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  store.set("risk_data_settings_v1", JSON.stringify({ alpacaKey: "PK_TEST", alpacaSecret: "SK_TEST" }));

  try {
    const p = new PaperPortfolio();
    p.reset(100000);
    p.setFlags({ alpacaSync: true });

    // 1. Alpaca HTTP 200 'accepted' with filled_qty=0 must NOT mutate cash or positions
    let sentClientOrderId = null;
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === "POST") {
        const payload = JSON.parse(opts.body);
        sentClientOrderId = payload.client_order_id;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "alp_1", client_order_id: sentClientOrderId, status: "accepted", filled_qty: "0" }),
        };
      }
      // Reconciliation GET returns actual broker fill at $152.30
      assert.ok(url.includes(`client_order_id=${encodeURIComponent(sentClientOrderId)}`));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "alp_1", client_order_id: sentClientOrderId, status: "filled", filled_qty: "10", filled_avg_price: "152.30" }),
      };
    };

    const accepted = await p.submitMarketOrder({ symbol: "AAPL", side: "buy", qty: 10, price: 150 });
    assert.equal(accepted.brokerStatus, "alpaca:accepted");
    assert.equal(p.state.cash, 100000, "Accepted order must not mutate local cash before fill");
    assert.equal(Object.keys(p.state.positions).length, 0, "Accepted order must not create local position before fill");
    assert.equal(p.state.brokerOrders.length, 1);

    const rec1 = await p.reconcileBrokerOrders();
    assert.equal(rec1.filled, 1);
    assert.equal(p.state.positions.AAPL.qty, 10);
    assert.equal(p.state.positions.AAPL.avgPrice, 152.3);
    assert.ok(Math.abs(p.state.cash - (100000 - 1523)) < 1e-6);

    // 2. Network error must record 'unknown' (NOT 'rejected') and reconcile via client_order_id
    globalThis.fetch = async () => { throw new Error("socket hang up"); };
    const unk = await p.submitMarketOrder({ symbol: "MSFT", side: "buy", qty: 5, price: 400 });
    assert.equal(unk.brokerStatus, "unknown");
    assert.ok(unk.clientOrderId);
    assert.equal(p.state.positions.MSFT, undefined);

    globalThis.fetch = async (url) => {
      assert.ok(url.includes(`client_order_id=${encodeURIComponent(unk.clientOrderId)}`));
      return { ok: false, status: 404, json: async () => ({ message: "not found" }) };
    };
    await p.reconcileBrokerOrders();
    const trackedUnk = p.state.brokerOrders.find((o) => o.clientOrderId === unk.clientOrderId);
    assert.equal(trackedUnk.status, "not_found");

    // 3. Partial fills derive incremental price from cumulative notional delta:
    //    5 shares @ $100, then cumulative 10 shares averaging $110 -> second 5 shares MUST book @ $120!
    const p2 = new PaperPortfolio();
    p2.reset(100000);
    p2.setFlags({ alpacaSync: true });
    let pollStep = 0;
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === "POST") {
        const cid = JSON.parse(opts.body).client_order_id;
        return { ok: true, status: 200, json: async () => ({ id: "alp_p", client_order_id: cid, status: "partially_filled", filled_qty: "5", filled_avg_price: "100" }) };
      }
      pollStep++;
      // Step 1: terminal 'filled' with missing price (null) -> must NOT drop order!
      if (pollStep === 1) {
        return { ok: true, status: 200, json: async () => ({ id: "alp_p", status: "filled", filled_qty: "10", filled_avg_price: null }) };
      }
      // Step 2: price arrives ($110 avg over 10 shares -> incremental 5 shares @ $120)
      return { ok: true, status: 200, json: async () => ({ id: "alp_p", status: "filled", filled_qty: "10", filled_avg_price: "110" }) };
    };

    await p2.submitMarketOrder({ symbol: "NVDA", side: "buy", qty: 10, price: 100 });
    assert.equal(p2.state.positions.NVDA.qty, 5);
    assert.equal(p2.state.positions.NVDA.avgPrice, 100);

    // First reconcile sees terminal status with missing price -> remains eligible!
    await p2.reconcileBrokerOrders();
    assert.equal(p2.state.positions.NVDA.qty, 5);
    assert.equal(p2._needsReconcile(p2.state.brokerOrders[0]), true);

    // Concurrent overlapping reconciliations must serialize and apply the second 5 shares ONCE at $120!
    await Promise.all([p2.reconcileBrokerOrders(), p2.reconcileBrokerOrders()]);
    assert.equal(p2.state.positions.NVDA.qty, 10);
    assert.ok(Math.abs(p2.state.positions.NVDA.avgPrice - 110) < 1e-6, `Expected avg $110, got ${p2.state.positions.NVDA.avgPrice}`);
    assert.ok(Math.abs(p2.state.cash - (100000 - 1100)) < 1e-6, `Expected cash 98900, got ${p2.state.cash}`);
    assert.equal(p2.state.trades[0].price, 120, `Second 5 shares must record incremental fill price $120, got ${p2.state.trades[0].price}`);
    assert.equal(p2._needsReconcile(p2.state.brokerOrders[0]), false);

    // 4. Unresolved orders are NEVER evicted when >50 terminal broker orders exist
    for (let i = 0; i < 60; i++) {
      p2.state.brokerOrders.unshift({ clientOrderId: `term_${i}`, status: "filled", reportedFilledQty: 1, reconciledQty: 1, reconciledNotional: 100 });
    }
    p2.state.brokerOrders.push({ clientOrderId: "keep_unresolved", status: "unknown", reportedFilledQty: 0, reconciledQty: 0, reconciledNotional: 0 });
    p2._pruneBrokerOrders();
    assert.ok(p2.state.brokerOrders.some((o) => o.clientOrderId === "keep_unresolved"), "Unresolved order must never be pruned");

    // 5. Legacy persisted partial order (without reconciledNotional) migrates cleanly in _load()
    store.set("risk_paper_portfolio_v1", JSON.stringify({
      startingCash: 100000,
      cash: 99500,
      positions: { NVDA: { symbol: "NVDA", qty: 5, avgPrice: 100, lastPrice: 100, entryFeeRemaining: 0 } },
      pendingOrders: [],
      brokerOrders: [{ brokerOrderId: "alp_legacy", clientOrderId: "cid_legacy", symbol: "NVDA", side: "buy", qty: 10, submittedPrice: 100, source: "manual", status: "partially_filled", reconciledQty: 5 }],
      trades: [{ id: "trd_1", time: Date.now(), symbol: "NVDA", side: "buy", qty: 5, price: 100, fee: 0, realizedPnl: 0, isClose: false, source: "manual", brokerStatus: "alpaca:partially_filled", clientOrderId: "cid_legacy" }],
      alpacaSync: true,
    }));
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "alp_legacy", client_order_id: "cid_legacy", status: "filled", filled_qty: "10", filled_avg_price: "110" }),
    });
    const pLegacy = new PaperPortfolio();
    assert.equal(pLegacy.state.brokerOrders[0].reconciledNotional, 500);
    await pLegacy.reconcileBrokerOrders();
    assert.equal(pLegacy.state.positions.NVDA.qty, 10);
    assert.equal(pLegacy.state.trades[0].price, 120, `Migrated legacy partial fill must book at $120, got ${pLegacy.state.trades[0].price}`);
    assert.ok(Math.abs(pLegacy.state.cash - 98900) < 1e-6, `Expected cash 98900, got ${pLegacy.state.cash}`);

    // 6. Rotated/incomplete legacy journal must NOT extrapolate prior notional (leaves NaN -> safe cumAvgPx fallback)
    store.set("risk_paper_portfolio_v1", JSON.stringify({
      startingCash: 100000,
      cash: 98900,
      positions: { NVDA: { symbol: "NVDA", qty: 10, avgPrice: 110, lastPrice: 110, entryFeeRemaining: 0 } },
      pendingOrders: [],
      brokerOrders: [{ brokerOrderId: "alp_rot", clientOrderId: "cid_rot", symbol: "NVDA", side: "buy", qty: 15, submittedPrice: 100, source: "manual", status: "partially_filled", reconciledQty: 10 }],
      trades: [{ id: "trd_2", time: Date.now(), symbol: "NVDA", side: "buy", qty: 5, price: 120, fee: 0, realizedPnl: 0, isClose: false, source: "manual", brokerStatus: "alpaca:partially_filled", clientOrderId: "cid_rot" }],
      alpacaSync: true,
    }));
    const pRotated = new PaperPortfolio();
    assert.equal(Number.isNaN(pRotated.state.brokerOrders[0].reconciledNotional), true, "Incomplete journal must not fabricate notional");
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "alp_rot", client_order_id: "cid_rot", status: "filled", filled_qty: "15", filled_avg_price: "115" }),
    });
    await pRotated.reconcileBrokerOrders();
    assert.equal(pRotated.state.trades[0].price, 115, "Safe fallback uses cumAvgPx when prior notional is incomplete");

    // 7. Legacy unpriced alpaca:partially_filled journal-only entry (full order qty) must NOT contaminate reconstructed notional
    store.set("risk_paper_portfolio_v1", JSON.stringify({
      startingCash: 100000,
      cash: 99500,
      positions: { NVDA: { symbol: "NVDA", qty: 5, avgPrice: 100, lastPrice: 100, entryFeeRemaining: 0 } },
      pendingOrders: [],
      brokerOrders: [{ brokerOrderId: "alp_j", clientOrderId: "cid_j", symbol: "NVDA", side: "buy", qty: 10, submittedPrice: 999, source: "manual", status: "partially_filled", reconciledQty: 5 }],
      trades: [
        { id: "trd_j1", time: Date.now(), symbol: "NVDA", side: "buy", qty: 10, price: 999, fee: 0, realizedPnl: 0, isClose: false, source: "manual", brokerStatus: "alpaca:partially_filled", clientOrderId: "cid_j" },
        { id: "trd_j2", time: Date.now(), symbol: "NVDA", side: "buy", qty: 5, price: 100, fee: 0, realizedPnl: 0, isClose: false, source: "manual", brokerStatus: "alpaca:partially_filled", clientOrderId: "cid_j" },
      ],
      alpacaSync: true,
    }));
    const pJournalContam = new PaperPortfolio();
    assert.equal(pJournalContam.state.brokerOrders[0].reconciledNotional, 500, "Journal-only unpriced partial entry must not contaminate notional");

    // 8. Legacy unpriced alpaca:partially_filled full-qty journal entry with rotated-out fills when reconciledQty === ordQty
    store.set("risk_paper_portfolio_v1", JSON.stringify({
      startingCash: 100000,
      cash: 98900,
      positions: { NVDA: { symbol: "NVDA", qty: 10, avgPrice: 110, lastPrice: 110, entryFeeRemaining: 0 } },
      pendingOrders: [],
      brokerOrders: [{ brokerOrderId: "alp_j2", clientOrderId: "cid_j2", symbol: "NVDA", side: "buy", qty: 10, submittedPrice: 999, source: "manual", status: "partially_filled", reconciledQty: 10 }],
      trades: [
        { id: "trd_j3", time: Date.now(), symbol: "NVDA", side: "buy", qty: 10, price: 999, fee: 0, realizedPnl: 0, isClose: false, source: "manual", brokerStatus: "alpaca:partially_filled", clientOrderId: "cid_j2" },
      ],
      alpacaSync: true,
    }));
    const pFullQtyRotated = new PaperPortfolio();
    assert.equal(Number.isNaN(pFullQtyRotated.state.brokerOrders[0].reconciledNotional), true, "Full-order-qty partially_filled journal entry must never be treated as a fill when reconciledQty === ordQty");
  } finally {
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test("SimSession: exact net-of-commission PnL, SL/TP brackets, next-open fills, and Co-Pilot prompt triggers", () => {
  const sim = new SimSession({ startingCash: 100000, feeBps: 10, slippageBps: 0, allowShort: false });
  sim.reset(100000, 50, 100);

  // 1. Instant bar-close round trip at flat price $100 with 10 bps fee -> realized PnL === equity - startingCash
  sim.executeOrder({ side: "buy", shares: 100, price: 100, barIdx: 50, time: 1000, stopLossPct: 5, takeProfitPct: 10 });
  assert.ok(Math.abs(sim.position.stopLossPrice - 95) < 1e-9);
  assert.ok(Math.abs(sim.position.takeProfitPrice - 110) < 1e-9);
  sim.executeOrder({ side: "sell", shares: 100, price: 100, barIdx: 51, time: 2000 });
  const st1 = sim.getStats(100);
  assert.ok(Math.abs(st1.realizedPnl - (-20)) < 1e-6);
  assert.ok(Math.abs(st1.equity - 99980) < 1e-6);
  assert.equal(st1.closedTotal, 1);

  // 2. Next-Bar-Open mode queues order and fills at next bar's Open, then Stop-Loss exits intrabar
  sim.fillMode = "next_open";
  const q = sim.submitUserAction({ side: "buy", exactShares: 50, price: 100, barIdx: 51, time: 2000, stopLossPct: 5, takeProfitPct: 15 });
  assert.equal(q.queued, true);
  assert.equal(sim.position, null);
  const evOpen = sim.processNewBarOpenAndBrackets({ o: 102, h: 104, l: 101, c: 103, t: 3000 }, 52);
  assert.equal(evOpen[0].type, "queued_fill");
  assert.equal(sim.position.avgPrice, 102);
  const slPx = sim.position.stopLossPrice; // 102 * 0.95 = 96.9
  const evSl = sim.processNewBarOpenAndBrackets({ o: 101, h: 102, l: 96, c: 97, t: 4000 }, 53);
  assert.equal(evSl[0].type, "stop_loss");
  assert.equal(sim.position, null);
  assert.ok(Math.abs(evSl[0].fill.price - slPx) < 1e-6);

  // 3. Co-Pilot Prompt Trigger: primes on initial bar, pauses on HOLD -> STRONG BUY shift
  sim.pauseMode = "signal_change";
  const bar0 = { o: 100, h: 101, l: 99, c: 100, t: 5000 };
  const p0 = sim.evaluateBarSignal({ barIdx: 50, bar: bar0, score: 5, thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 } });
  assert.equal(p0, null, "Initial prime bar should not fire prompt");
  const p1 = sim.evaluateBarSignal({ barIdx: 51, bar: bar0, score: 65, thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 } });
  assert.ok(p1 && p1.kind === "buy" && p1.headline.includes("STRONG BUY"));
  // Repeating same rating does not re-trigger
  const p2 = sim.evaluateBarSignal({ barIdx: 52, bar: bar0, score: 70, thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 } });
  assert.equal(p2, null);
});

test("computeLiveTradeRecommendation: ATR-based SL/TP sizing, exit recommendation on open long, null on HOLD", async () => {
  const bars = makeSyntheticBars(60);
  const score = new Float64Array(60);
  const p = new PaperPortfolio();
  p.reset(100000);

  // HOLD -> no popup
  score[59] = 4;
  assert.equal(computeLiveTradeRecommendation({ symbol: "NVDA", bars, score, portfolio: p }), null);

  // STRONG BUY when flat -> recommends LONG with ATR stop < entry < target and risk-bounded shares
  score[59] = 68;
  const buyRec = computeLiveTradeRecommendation({ symbol: "NVDA", bars, score, portfolio: p, riskPct: 1.5 });
  assert.equal(buyRec.action, "buy");
  assert.ok(buyRec.stopLoss < buyRec.entryPx && buyRec.takeProfit > buyRec.entryPx);
  assert.ok(buyRec.shares >= 1 && buyRec.rrRatio >= 1.5);

  // Once long, SELL signal recommends FLATTEN / EXIT of the exact held quantity
  await p.submitMarketOrder({ symbol: "NVDA", side: "buy", qty: 50, price: buyRec.entryPx });
  score[59] = -40;
  const exitRec = computeLiveTradeRecommendation({ symbol: "NVDA", bars, score, portfolio: p });
  assert.equal(exitRec.action, "flatten");
  assert.equal(exitRec.shares, 50);

  // When flat with allowShort=false, SELL signal returns 'caution' (NEVER a bypass short order!)
  const pFlat = new PaperPortfolio();
  pFlat.reset(100000);
  pFlat.setFlags({ allowShort: false });
  const cautionRec = computeLiveTradeRecommendation({ symbol: "NVDA", bars, score, portfolio: pFlat, allowShort: false });
  assert.equal(cautionRec.action, "caution");
  assert.equal(cautionRec.shares, 0);
});

test("PaperPortfolio: OCO bracket cancels sibling (stop-first), respects post-order bar time, guards shorting, and sends Alpaca native bracket", async () => {
  const p = new PaperPortfolio();
  p.reset(100000);
  p.setFlags({ alpacaSync: false, allowShort: false, feeBps: 0, slippageBps: 0 });

  // 1. Short guard blocks opening a short when allowShort is false
  await assert.rejects(() => p.submitMarketOrder({ symbol: "NVDA", side: "sell", qty: 10, price: 100 }), /Shorting is disabled/);

  // 2. Buy 100 @ $100 with linked OCO SL=$95 / TP=$110 on bar t=1000
  await p.submitMarketOrder({ symbol: "NVDA", side: "buy", qty: 100, price: 100, stopLoss: 95, takeProfit: 110, eligibleAfterBarTime: 1000 });
  assert.equal(p.state.pendingOrders.length, 2);

  // Bar at t=1000 (creation bar) must NOT trigger SL/TP on prior intrabar H/L!
  await p.processBar("NVDA", { t: 1000, o: 100, h: 120, l: 80, c: 100 });
  assert.equal(p.state.positions.NVDA.qty, 100);
  assert.equal(p.state.pendingOrders.length, 2);

  // Next bar t=2000 touches BOTH SL ($95) and TP ($110): conservative Stop-First fills SL ONLY, cancels sibling TP, position goes flat (NEVER reverses!)
  await p.processBar("NVDA", { t: 2000, o: 100, h: 115, l: 90, c: 105 });
  assert.equal(p.state.positions.NVDA, undefined, "Position must be flat after OCO SL fill");
  assert.equal(p.state.pendingOrders.length, 0, "Sibling OCO TP must be cancelled automatically");
  assert.equal(p.state.trades[0].price, 95, "Stop-first must fill at SL $95");

  // 2b. Gap-down through stop ($95 stop on bar opening at $80) must fill at gap Open ($80), NOT $95!
  await p.submitMarketOrder({ symbol: "AMD", side: "buy", qty: 10, price: 100, stopLoss: 95, takeProfit: 115, eligibleAfterBarTime: 2000 });
  await p.processBar("AMD", { t: 3000, o: 80, h: 85, l: 78, c: 82 });
  assert.equal(p.state.positions.AMD, undefined);
  assert.equal(p.state.pendingOrders.length, 0);
  assert.equal(p.state.trades[0].price, 80, "Sell stop gapped through at Open $80 must fill at $80, not $95");

  // 2c. Failed OCO trigger submission (e.g. switched to Alpaca sync with no keys -> rejected) must PRESERVE protective OCO legs!
  await p.submitMarketOrder({ symbol: "TSLA", side: "buy", qty: 10, price: 200, stopLoss: 190, takeProfit: 220, eligibleAfterBarTime: 3000 });
  assert.equal(p.state.pendingOrders.length, 2);
  p.setFlags({ alpacaSync: true }); // no keys -> submitMarketOrder returns rejected (applied: false)
  await p.processBar("TSLA", { t: 4000, o: 188, h: 192, l: 185, c: 186 });
  assert.equal(p.state.positions.TSLA.qty, 10, "Position remains open when broker rejects exit");
  assert.equal(p.state.pendingOrders.length, 2, "OCO legs must remain intact when triggered submission fails/rejects");
  p.setFlags({ alpacaSync: false });
  p.cancelPositionBrackets("TSLA");

  // 2d. Unresolved broker exit (accepted/unknown) locks OCO group against duplicate submissions across ticks & concurrent processBar calls!
  const origLS2 = globalThis.localStorage;
  const origF2 = globalThis.fetch;
  const st2 = new Map();
  globalThis.localStorage = { getItem: (k) => st2.get(k) ?? null, setItem: (k, v) => st2.set(k, String(v)), removeItem: (k) => st2.delete(k) };
  st2.set("risk_data_settings_v1", JSON.stringify({ alpacaKey: "PK", alpacaSecret: "SK" }));
  let postCount = 0;
  let lastCid = null;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === "POST") {
      postCount++;
      lastCid = JSON.parse(opts.body).client_order_id;
      return { ok: true, status: 200, json: async () => ({ id: "alp_ex", client_order_id: lastCid, status: "accepted", filled_qty: "0" }) };
    }
    // Reconcile fills the exit order cleanly -> removes OCO legs!
    return { ok: true, status: 200, json: async () => ({ id: "alp_ex", client_order_id: lastCid, status: "filled", filled_qty: "10", filled_avg_price: "94" }) };
  };
  try {
    await p.submitMarketOrder({ symbol: "META", side: "buy", qty: 10, price: 100, stopLoss: 95, takeProfit: 115, eligibleAfterBarTime: 4000 });
    p.setFlags({ alpacaSync: true });
    // Two concurrent triggering ticks + a third tick must ONLY send ONE broker exit!
    await Promise.all([
      p.processBar("META", { t: 5000, o: 94, h: 96, l: 93, c: 94 }, { isLiveTick: true }),
      p.processBar("META", { t: 5001, o: 94, h: 95, l: 92, c: 93 }, { isLiveTick: true }),
    ]);
    await p.processBar("META", { t: 5002, o: 93, h: 94, l: 91, c: 92 }, { isLiveTick: true });
    assert.equal(postCount, 1, "Unresolved OCO exit must never submit duplicate broker exits on subsequent/concurrent ticks");
    assert.equal(p.state.pendingOrders.length, 2, "OCO legs remain tracked (locked) until reconciled");
    await p.reconcileBrokerOrders();
    assert.equal(p.state.positions.META, undefined, "Reconciled exit closes META position");
    assert.equal(p.state.pendingOrders.length, 0, "Reconciled exit cleans up OCO legs");

    // 2d-ii. Broker 404 on an unknown exit must release the OCO lock so protection stays active!
    p.setFlags({ alpacaSync: false });
    await p.submitMarketOrder({ symbol: "INTC", side: "buy", qty: 10, price: 30, stopLoss: 28, takeProfit: 35, eligibleAfterBarTime: 5000 });
    p.setFlags({ alpacaSync: true });
    let intcPhase = "network_fail";
    let intcPosts = 0;
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === "POST") {
        intcPosts++;
        lastCid = JSON.parse(opts.body).client_order_id;
        if (intcPhase === "network_fail") throw new Error("timeout");
        return { ok: true, status: 200, json: async () => ({ id: "alp_intc2", client_order_id: lastCid, status: "filled", filled_qty: "10", filled_avg_price: "27.5" }) };
      }
      // 404 -> unknown order never reached Alpaca -> becomes not_found -> MUST release OCO lock!
      return { ok: false, status: 404, json: async () => ({ message: "order not found" }) };
    };
    await p.processBar("INTC", { t: 6000, o: 27.5, h: 28.2, l: 27.0, c: 27.5 }, { isLiveTick: true });
    assert.equal(intcPosts, 1);
    assert.ok(p.state.pendingOrders.every((o) => o.symbol !== "INTC" || o.inFlightClientOrderId), "Unknown exit locks INTC OCO");
    await p.reconcileBrokerOrders();
    assert.ok(p.state.pendingOrders.every((o) => o.symbol !== "INTC" || o.inFlightClientOrderId === null), "404 not_found must release OCO lock");
    intcPhase = "fill_ok";
    await p.processBar("INTC", { t: 6001, o: 27.5, h: 28.0, l: 27.0, c: 27.5 }, { isLiveTick: true });
    assert.equal(intcPosts, 2, "Unlocked OCO must retry and exit INTC after 404 not_found");
    assert.equal(p.state.positions.INTC, undefined, "INTC position closed after OCO retry");

    // 2d-iii. Immediate partial fill on broker exit must NOT remove OCO legs; reduces qty, locks while open, unlocks on cancel!
    p.setFlags({ alpacaSync: false });
    await p.submitMarketOrder({ symbol: "GOOG", side: "buy", qty: 10, price: 200, stopLoss: 190, takeProfit: 220, eligibleAfterBarTime: 6000 });
    p.setFlags({ alpacaSync: true });
    let googPosts = 0;
    globalThis.fetch = async (url, opts) => {
      if (opts?.method === "POST") {
        googPosts++;
        lastCid = JSON.parse(opts.body).client_order_id;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "alp_goog_part",
            client_order_id: lastCid,
            status: "partially_filled",
            filled_qty: "4",
            filled_avg_price: "189",
          }),
        };
      }
      // Broker cancels the remaining 6 shares -> must release lock while keeping 6-share OCO active!
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "alp_goog_part",
          client_order_id: lastCid,
          status: "canceled",
          filled_qty: "4",
          filled_avg_price: "189",
        }),
      };
    };
    await p.processBar("GOOG", { t: 7000, o: 189, h: 191, l: 188, c: 189 }, { isLiveTick: true });
    assert.equal(p.state.positions.GOOG.qty, 6, "Immediate partial fill leaves 6 shares open");
    const googOco = p.state.pendingOrders.filter((o) => o.symbol === "GOOG");
    assert.equal(googOco.length, 2, "Both protective OCO legs must remain after immediate partial fill");
    assert.ok(googOco.every((o) => o.qty === 6 && o.inFlightClientOrderId === lastCid), "OCO legs reduced to 6 shares and locked");
    // Second tick while still partially_filled must NOT send duplicate exit
    await p.processBar("GOOG", { t: 7001, o: 188, h: 189, l: 187, c: 188 }, { isLiveTick: true });
    assert.equal(googPosts, 1, "Locked partially-filled OCO must not submit duplicate exit");
    await p.reconcileBrokerOrders();
    const googOcoAfterCancel = p.state.pendingOrders.filter((o) => o.symbol === "GOOG");
    assert.equal(googOcoAfterCancel.length, 2, "Both OCO legs stay active after partial exit cancels");
    assert.ok(googOcoAfterCancel.every((o) => o.qty === 6 && o.inFlightClientOrderId === null), "OCO lock released for remaining 6 shares");
    p.cancelPositionBrackets("GOOG");
  } finally {
    globalThis.fetch = origF2;
    globalThis.localStorage = origLS2;
    p.setFlags({ alpacaSync: false });
  }

  // 2e. SimSession shadow strategy mirrors allowShort & SL/TP brackets — including entry-bar brackets and open reversals!
  const simShadow = new SimSession({ startingCash: 100000, feeBps: 0, slippageBps: 0, allowShort: true, shadowStopLossPct: 5, shadowTakeProfitPct: 10 });
  simShadow.reset(100000, 10, 100);
  simShadow.evaluateBarSignal({ barIdx: 10, bar: { o: 100, h: 101, l: 99, c: 100, t: 1000 }, score: -50, thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 } });
  // Entry bar opens at $100 (enters short) and immediately plunges to $89 (crosses 10% TP at $90 on entry bar!)
  simShadow.processNewBarOpenAndBrackets({ o: 100, h: 101, l: 89, c: 91, t: 2000 }, 11);
  assert.equal(simShadow.shadow.qty, 0, "Shadow short entered at open must trigger TP on entry bar itself");
  assert.ok(simShadow.getStats(91).shadowReturnPct > 9.5, "Entry-bar shadow short TP must realize ~+10%");

  // Pending reversal at bar open must execute BEFORE intrabar brackets on the old position!
  const simRev = new SimSession({ startingCash: 100000, feeBps: 0, slippageBps: 0, allowShort: true, shadowStopLossPct: 5, shadowTakeProfitPct: 10 });
  simRev.reset(100000, 10, 100);
  simRev.evaluateBarSignal({ barIdx: 10, bar: { o: 100, h: 101, l: 99, c: 100, t: 1000 }, score: 50, thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 } });
  simRev.processNewBarOpenAndBrackets({ o: 100, h: 102, l: 98, c: 101, t: 2000 }, 11);
  assert.ok(simRev.shadow.qty > 0, "Shadow enters long at bar 11 open");
  // Bar 11 close queues a sell reversal for bar 12 open
  simRev.evaluateBarSignal({ barIdx: 11, bar: { o: 100, h: 102, l: 98, c: 101, t: 2000 }, score: -50, thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 } });
  // Bar 12 opens at $101 (reverses long -> short at $101), then drops to $94 (would have stopped old long at $95, but is favorable for new short!)
  simRev.processNewBarOpenAndBrackets({ o: 101, h: 102, l: 94, c: 95, t: 3000 }, 12);
  assert.ok(simRev.shadow.qty < 0, "Queued open reversal must flip to short at open instead of being superseded by old long's intrabar stop");

  // 3. Flatten cancels orphaned OCO brackets automatically
  await p.submitMarketOrder({ symbol: "SPY", side: "buy", qty: 10, price: 500, stopLoss: 480, takeProfit: 540, eligibleAfterBarTime: 2000 });
  assert.equal(p.state.pendingOrders.length, 2);
  await p.submitMarketOrder({ symbol: "SPY", side: "sell", qty: 10, price: 505, source: "flatten", bypassShortGuard: true });
  assert.equal(p.state.pendingOrders.length, 0, "Flattening position must cancel all linked OCO brackets");

  // 4. Alpaca sync sends broker-native order_class='bracket' and does NOT fabricate local resting orders
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  store.set("risk_data_settings_v1", JSON.stringify({ alpacaKey: "PK", alpacaSecret: "SK" }));
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ id: "alp_b", client_order_id: sentBody.client_order_id, status: "accepted", filled_qty: "0" }) };
  };
  try {
    const pAlp = new PaperPortfolio();
    pAlp.reset(100000);
    pAlp.setFlags({ alpacaSync: true });
    await pAlp.submitMarketOrder({ symbol: "NVDA", side: "buy", qty: 10, price: 100, stopLoss: 95, takeProfit: 112 });
    assert.equal(sentBody.order_class, "bracket");
    assert.equal(sentBody.stop_loss.stop_price, "95");
    assert.equal(sentBody.take_profit.limit_price, "112");
    assert.equal(pAlp.state.pendingOrders.length, 0, "Alpaca bracket must not fabricate local resting orders");
  } finally {
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test("WASM runThresholdSweep matches exact argument signature and 4-float stride", async () => {
  const wasm = await loadWasm();
  const bars = makeSyntheticBars(240);
  populateBars(wasm, bars);
  wasm.resetComposite();
  wasm.computeIndicator(1, 12, 26, 0, 0, 0);
  wasm.accumulateRule(1.0, 0, 0.35, 0.25);
  wasm.finalizeComposite();

  const g = wasm.runThresholdSweep(8, 56, -56, -8, 4, 0, 100000, 100, 0, 0, 1, 2, 252);
  assert.equal(g, 4);
  const buf = new Float64Array(wasm.memory.buffer, wasm.getSweepPtr(), g * g * 4);
  let sawTrades = 0;
  for (let i = 0; i < g * g; i++) {
    const sr = buf[i * 4];
    const ret = buf[i * 4 + 1];
    const dd = buf[i * 4 + 2];
    const tr = buf[i * 4 + 3];
    assert.ok(Number.isFinite(sr) && Number.isFinite(ret) && Number.isFinite(dd) && tr >= 0 && Number.isInteger(tr));
    if (tr > 0) sawTrades++;
  }
  assert.ok(sawTrades > 0, "Sweep grid should produce closed train trades");
});
