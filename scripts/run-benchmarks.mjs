#!/usr/bin/env node
// Real Multi-Asset WebAssembly Benchmark Suite across Major Indexes, Big Tech & Fortune 100 Blue Chips.
// Runs all 24 built-in strategies through compiled public/risk-engine.wasm using STRICT 70% Train / 30% Held-Out OOS splits.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_STRATEGIES, materializeStrategy } from "../public/src/data/strategies.js";
import { BENCHMARK_TICKERS, UNIVERSE_BY_SYMBOL } from "../public/src/data/universe.js";
import { getBarsPerYear } from "../public/src/data/marketData.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const WASM_PATH = path.join(ROOT, "public", "risk-engine.wasm");
const OUT_PATH = path.join(ROOT, "public", "src", "data", "benchmarks.json");
const PROXY_BASE = process.env.RISK_PROXY_BASE || "http://localhost:5180/api/market";

// Benchmark matrix: timeframe/range combos + risk profiles
const TIMEFRAMES = [
  { interval: "1d", range: "1y" },
  { interval: "1d", range: "2y" },
  { interval: "1h", range: "3mo" },
  { interval: "15m", range: "1mo" },
];

const RISK_PROFILES = [
  { id: "default", label: "Standard Long", allowShort: false, stopLossPct: 0, takeProfitPct: 0, useSweep: false },
  { id: "bracket", label: "Risk-Managed (SL 5% / TP 15%)", allowShort: false, stopLossPct: 5, takeProfitPct: 15, useSweep: false },
  { id: "long_short", label: "Long / Short", allowShort: true, stopLossPct: 6, takeProfitPct: 18, useSweep: false },
  { id: "train_opt", label: "Train-Optimized Cutoffs", allowShort: false, stopLossPct: 5, takeProfitPct: 15, useSweep: true },
];

async function loadWasm() {
  const bytes = await fs.readFile(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { abort() { throw new Error("WASM abort"); } },
  });
  return instance.exports;
}

async function fetchSeries(symbol, interval, range) {
  const url = `${PROXY_BASE}/chart?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol} ${interval}/${range}`);
  const data = await res.json();
  if (!data?.bars?.length || data.bars.length < 70) {
    throw new Error(`Insufficient bars (${data?.bars?.length || 0}) for ${symbol} ${interval}/${range}`);
  }
  return data;
}

function populateWasmBars(wasm, bars) {
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

function readMetrics(wasm) {
  const m = new Float64Array(wasm.memory.buffer, wasm.getMetricsPtr(), 20);
  return {
    totalReturnPct: Number(m[0].toFixed(2)),
    bhReturnPct: Number(m[1].toFixed(2)),
    alphaPct: Number((m[0] - m[1]).toFixed(2)),
    sharpe: Number(m[3].toFixed(2)),
    maxDrawdownPct: Number(m[5].toFixed(1)),
    winRatePct: Number(m[6].toFixed(1)),
    profitFactor: Number(Math.min(99.9, m[7]).toFixed(2)),
    numTrades: Math.round(m[8]),
    oosReturnPct: Number(m[12].toFixed(2)),
    oosSharpe: Number(m[13].toFixed(2)),
    oosMaxDDPct: Number(m[14].toFixed(1)),
    oosTrades: Math.round(m[15]),
    trainReturnPct: Number(m[16].toFixed(2)),
    trainSharpe: Number(m[17].toFixed(2)),
    trainMaxDDPct: Number(m[18].toFixed(1)),
    trainTrades: Math.round(m[19]),
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
}

async function main() {
  const t0 = Date.now();
  const wasm = await loadWasm();
  const strategies = BUILTIN_STRATEGIES.map(materializeStrategy);

  // Fetch all ticker × timeframe series with bounded concurrency
  console.log(`Fetching ${BENCHMARK_TICKERS.length} tickers × ${TIMEFRAMES.length} timeframes from ${PROXY_BASE}…`);
  const datasets = [];
  const queue = [];
  for (const symbol of BENCHMARK_TICKERS) {
    for (const tf of TIMEFRAMES) {
      queue.push({ symbol, ...tf });
    }
  }

  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const job = queue[idx++];
      try {
        const data = await fetchSeries(job.symbol, job.interval, job.range);
        datasets.push({ ...job, bars: data.bars, name: UNIVERSE_BY_SYMBOL.get(job.symbol)?.name || data.name || job.symbol });
      } catch (err) {
        console.warn(`  [skip] ${job.symbol} ${job.interval}/${job.range}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Fetched ${datasets.length}/${queue.length} series in ${((Date.now() - t0) / 1000).toFixed(1)}s. Running WASM benchmark matrix…`);

  // Collect per-strategy benchmark runs
  const runsByStrategy = new Map(strategies.map((s) => [s.id, []]));
  let totalBacktests = 0;

  for (const ds of datasets) {
    populateWasmBars(wasm, ds.bars);
    const barsPerYear = getBarsPerYear(ds.interval);
    const n = ds.bars.length;

    // Cache indicator signals across all 24 strategies for this series
    const indCache = new Map();
    const getIndSig = (rule) => {
      const key = `${rule.indicatorId}|${rule.params.p1}|${rule.params.p2}|${rule.params.p3}|${rule.params.p4}|${rule.invert ? 1 : 0}`;
      let cached = indCache.get(key);
      if (!cached) {
        wasm.computeIndicator(rule.indicatorId, rule.params.p1, rule.params.p2, rule.params.p3, rule.params.p4, rule.invert ? 1 : 0);
        cached = new Float64Array(wasm.memory.buffer, wasm.getSigPtr(), n).slice();
        indCache.set(key, cached);
      }
      return cached;
    };

    for (const strat of strategies) {
      wasm.resetComposite();
      const sigView = new Float64Array(wasm.memory.buffer, wasm.getSigPtr(), n);
      for (const rule of strat.rules) {
        if (!rule.enabled) continue;
        sigView.set(getIndSig(rule));
        wasm.accumulateRule(rule.weight, rule.mode, rule.triggerThresh, rule.vetoThresh);
      }
      wasm.finalizeComposite();

      // Evaluate each risk profile for this strategy on this dataset
      for (const prof of RISK_PROFILES) {
        let buyThresh = strat.thresholds.buy;
        let sellThresh = strat.thresholds.sell;

        if (prof.useSweep) {
          // Optimize strictly on 70% Train slice (10×10 exact integer-step grid: step = (55-10)/9 = 5.0 exactly!)
          // engine.ts signature: (buyMin, buyMax, sellMin, sellMax, gridSize, allowShort, initialCap, posPct, sl, tp, commBps, slipBps, barsPerYear)
          const grid = 10;
          const buyMin = 10; const buyMax = 55;
          const sellMin = -55; const sellMax = -10;
          wasm.runThresholdSweep(buyMin, buyMax, sellMin, sellMax, grid, prof.allowShort ? 1 : 0, 100000, 100, prof.stopLossPct, prof.takeProfitPct, 1, 2, barsPerYear);
          const sBuf = new Float64Array(wasm.memory.buffer, wasm.getSweepPtr(), grid * grid * 4);
          let bestCell = null;
          for (let r = 0; r < grid; r++) {
            const bt = buyMin + (r / (grid - 1)) * (buyMax - buyMin); // exact integer: 10, 15, ..., 55
            for (let c = 0; c < grid; c++) {
              const st = sellMin + (c / (grid - 1)) * (sellMax - sellMin); // exact integer: -55, -50, ..., -10
              const k = (r * grid + c) * 4;
              const sr = sBuf[k];
              const tr = Math.round(sBuf[k + 3]);
              if (tr >= 5 && Number.isFinite(sr) && (!bestCell || sr > bestCell.sr)) {
                bestCell = { bt, st, sr };
              }
            }
          }
          if (!bestCell) continue; // Honest: skip if no threshold met >=5 closed train trades
          buyThresh = bestCell.bt;
          sellThresh = bestCell.st;
        }

        wasm.runBacktest(buyThresh, sellThresh, prof.allowShort ? 1 : 0, 100000, 100, prof.stopLossPct, prof.takeProfitPct, 1, 2, barsPerYear);
        totalBacktests++;
        const m = readMetrics(wasm);
        if (m.trainTrades < 3) continue; // Ignore degenerate zero-activity runs

        // Strictly Train-only quality score (for sorting top setups without OOS peeking!)
        const shrink = m.trainTrades / (m.trainTrades + 5);
        const trainQuality = m.trainSharpe * shrink - Math.max(0, m.trainMaxDDPct - 18) * 0.015;
        const oosSplitIdx = Math.floor(n * 0.7);

        runsByStrategy.get(strat.id).push({
          symbol: ds.symbol,
          group: UNIVERSE_BY_SYMBOL.get(ds.symbol)?.group || "other",
          interval: ds.interval,
          range: ds.range,
          bars: n,
          startTime: ds.bars[0].t,
          endTime: ds.bars[n - 1].t,
          oosSplitIdx,
          oosSplitTime: ds.bars[Math.min(n - 1, oosSplitIdx)].t,
          profileId: prof.id,
          profileLabel: prof.label,
          settings: {
            buyThresh,
            sellThresh,
            strongBuy: Math.min(95, Math.max(buyThresh + 22, 48)),
            strongSell: Math.max(-95, Math.min(sellThresh - 22, -48)),
            initialCapital: 100000,
            positionPct: 100,
            commissionBps: 1,
            slippageBps: 2,
            allowShort: prof.allowShort,
            stopLossPct: prof.stopLossPct,
            takeProfitPct: prof.takeProfitPct,
          },
          metrics: m,
          trainQuality: Number(trainQuality.toFixed(3)),
        });
      }
    }
  }

  // Summarize every strategy across the entire blue-chip + index universe
  const strategySummaries = strategies.map((strat) => {
    const runs = runsByStrategy.get(strat.id) || [];
    const oosSharpes = runs.filter((r) => r.metrics.oosTrades >= 1).map((r) => r.metrics.oosSharpe);
    const trainSharpes = runs.map((r) => r.metrics.trainSharpe);
    const oosReturns = runs.filter((r) => r.metrics.oosTrades >= 1).map((r) => r.metrics.oosReturnPct);
    const posOosCount = runs.filter((r) => r.metrics.oosTrades >= 1 && r.metrics.oosReturnPct > 0).length;
    const oosActiveCount = runs.filter((r) => r.metrics.oosTrades >= 1).length;

    // Select best 70%-Train configuration for EACH ticker (so all 26 flagship blue-chips & indexes appear under every strategy!)
    const sorted = runs.slice().sort((a, b) => b.trainQuality - a.trainQuality);
    const seenSym = new Set();
    const topRuns = [];
    for (const r of sorted) {
      if (seenSym.has(r.symbol)) continue;
      seenSym.add(r.symbol);
      topRuns.push(r);
    }

    const medTrainSharpe = Number(median(trainSharpes).toFixed(2));
    const medOosSharpe = Number(median(oosSharpes).toFixed(2));
    const medOosRet = Number(median(oosReturns).toFixed(2));
    const oosHitRatePct = oosActiveCount > 0 ? Number(((posOosCount / oosActiveCount) * 100).toFixed(1)) : 0;

    return {
      strategyId: strat.id,
      name: strat.name,
      family: strat.family,
      totalRuns: runs.length,
      medianTrainSharpe: medTrainSharpe,
      medianOosSharpe: medOosSharpe,
      medianOosReturnPct: medOosRet,
      oosHitRatePct,
      bestRun: topRuns[0] || null,
      runs: topRuns,
    };
  });

  // Rank strategies globally across all 25 blue-chips & indexes strictly by cross-market Median Train Sharpe
  strategySummaries.sort((a, b) => b.medianTrainSharpe - a.medianTrainSharpe);
  strategySummaries.forEach((s, i) => { s.globalRank = i + 1; });

  const payload = {
    generatedAt: new Date().toISOString(),
    tickersTested: [...new Set(datasets.map((d) => d.symbol))],
    timeframesTested: TIMEFRAMES,
    profilesTested: RISK_PROFILES.map((p) => p.label),
    totalBacktests,
    elapsedMs: Date.now() - t0,
    strategies: strategySummaries,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n✓ Completed ${totalBacktests} WASM backtests across ${payload.tickersTested.length} blue-chips & indexes in ${(payload.elapsedMs / 1000).toFixed(1)}s!`);
  console.log(`✓ Saved to ${OUT_PATH}`);
  console.log("\nTop 8 Cross-Market Strategies (Ranked strictly on 70% Train Median Sharpe; 30% OOS untouched):");
  for (const s of strategySummaries.slice(0, 8)) {
    const b = s.bestRun;
    console.log(
      `  #${s.globalRank} ${s.name.padEnd(32)} | Med Train SR: ${String(s.medianTrainSharpe).padStart(5)} | Med OOS SR: ${String(s.medianOosSharpe).padStart(5)} | OOS Win%: ${String(s.oosHitRatePct).padStart(5)}% | Best: ${b?.symbol} ${b?.interval}/${b?.range} (${b?.profileLabel})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
