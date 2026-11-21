// Dedicated Web Worker hosting the 62-indicator risk-engine.wasm binary
// Strictly causal tournament ranking, rolling-rebalance Sharpe ensemble, live draft preview & 62-indicator signal snapshot.

let wasm = null;
let currentN = 0;

async function ensureWasm() {
  if (wasm) return wasm;
  const url = new URL("../../risk-engine.wasm", import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch risk-engine.wasm (${res.status})`);
  const bytes = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      abort() {
        throw new Error("WASM engine abort");
      },
    },
  });
  wasm = instance.exports;
  return wasm;
}

function viewF64(ptr, len) {
  return new Float64Array(wasm.memory.buffer, ptr, len);
}

function copyF64(ptr, len) {
  return new Float64Array(wasm.memory.buffer, ptr, len).slice();
}

function loadBarsIntoWasm(bars) {
  const n = bars.length;
  currentN = n;
  wasm.initBars(n);
  const o = viewF64(wasm.getOpenPtr(), n);
  const h = viewF64(wasm.getHighPtr(), n);
  const l = viewF64(wasm.getLowPtr(), n);
  const c = viewF64(wasm.getClosePtr(), n);
  const v = viewF64(wasm.getVolumePtr(), n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    o[i] = b.o; h[i] = b.h; l[i] = b.l; c[i] = b.c; v[i] = b.v;
  }
  wasm.prepareBaseSeries();
}

function readMetricsObj() {
  const m = viewF64(wasm.getMetricsPtr(), 20);
  return {
    totalReturnPct: m[0],
    bhReturnPct: m[1],
    cagrPct: m[2],
    sharpe: m[3],
    sortino: m[4],
    maxDrawdownPct: m[5],
    winRatePct: m[6],
    profitFactor: m[7],
    numTrades: Math.round(m[8]),
    avgTradePct: m[9],
    exposurePct: m[10],
    finalEquity: m[11],
    // Strictly untouched held-out final 30% Out-of-Sample window
    oosReturnPct: m[12],
    oosSharpe: m[13],
    oosMaxDDPct: m[14],
    oosTrades: Math.round(m[15]),
    // Strictly 70% Train In-Sample window (used for honest strategy ranking!)
    trainReturnPct: m[16],
    trainSharpe: m[17],
    trainMaxDDPct: m[18],
    trainTrades: Math.round(m[19]),
  };
}

function computeQuantRankScore(m) {
  // Strictly uses 70% TRAIN metrics ONLY — NEVER peeks at the held-out 30% OOS validation slice!
  const trN = m.trainTrades ?? 0;
  const shrink = trN / (trN + 6);
  const noTradePenalty = trN === 0 ? -45 : 0;
  const sharpePart = Math.max(-3, Math.min(5, m.trainSharpe || 0)) * 28 * shrink;
  const retPart = Math.max(-50, Math.min(180, m.trainReturnPct || 0)) * 0.25 * shrink;
  const ddPenalty = Math.min(60, m.trainMaxDDPct || 0) * -0.6;
  return sharpePart + retPart + ddPenalty + noTradePenalty;
}

function downsample(arr, maxPts = 64) {
  if (arr.length <= maxPts) return Array.from(arr);
  const out = new Array(maxPts);
  const step = (arr.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) out[i] = arr[Math.round(i * step)];
  return out;
}

function runScorePipeline({ scoreOverride, rules, backtestCfg, forecastCfg, runSweep, runMc }) {
  const t0 = performance.now();
  const n = currentN;
  const ruleResults = [];

  if (scoreOverride && scoreOverride.length === n) {
    viewF64(wasm.getScorePtr(), n).set(scoreOverride);
  } else {
    wasm.resetComposite();
    for (const r of rules) {
      const p1 = Number(r.params?.p1 ?? 0);
      const p2 = Number(r.params?.p2 ?? 0);
      const p3 = Number(r.params?.p3 ?? 0);
      const p4 = Number(r.params?.p4 ?? 0);
      const linesCount = wasm.computeIndicator(r.indicatorId, p1, p2, p3, p4, r.invert ? 1 : 0);

      if (r.enabled) {
        wasm.accumulateRule(
          Number(r.weight ?? 1),
          Number(r.mode ?? 0),
          Number(r.triggerThresh ?? 0.35),
          Number(r.vetoThresh ?? 0.25)
        );
      }

      const lines = [copyF64(wasm.getOut0Ptr(), n)];
      if (linesCount >= 2) lines.push(copyF64(wasm.getOut1Ptr(), n));
      if (linesCount >= 3) lines.push(copyF64(wasm.getOut2Ptr(), n));
      if (linesCount >= 4) lines.push(copyF64(wasm.getOut3Ptr(), n));

      ruleResults.push({
        uid: r.uid,
        indicatorId: r.indicatorId,
        key: r.key,
        lines,
        sig: copyF64(wasm.getSigPtr(), n),
      });
    }
    wasm.finalizeComposite();
  }

  const score = copyF64(wasm.getScorePtr(), n);

  const bt = backtestCfg || {};
  const tradeCount = wasm.runBacktest(
    Number(bt.buyThresh ?? 18), Number(bt.sellThresh ?? -18),
    bt.allowShort ? 1 : 0, Number(bt.initialCapital ?? 100000), Number(bt.positionPct ?? 100),
    Number(bt.stopLossPct ?? 0), Number(bt.takeProfitPct ?? 0),
    Number(bt.commissionBps ?? 1), Number(bt.slippageBps ?? 2), Number(bt.barsPerYear ?? 252)
  );

  const equity = copyF64(wasm.getEquityPtr(), n);
  const bhEquity = copyF64(wasm.getBhEquityPtr(), n);
  const drawdown = copyF64(wasm.getDrawdownPtr(), n);
  const metrics = readMetricsObj();

  const rawTrades = viewF64(wasm.getTradesPtr(), tradeCount * 8);
  const trades = [];
  for (let i = 0; i < tradeCount; i++) {
    const base = i * 8;
    trades.push({
      entryIdx: Math.round(rawTrades[base]),
      exitIdx: Math.round(rawTrades[base + 1]),
      side: rawTrades[base + 2] > 0 ? "LONG" : "SHORT",
      entryPrice: rawTrades[base + 3],
      exitPrice: rawTrades[base + 4],
      pnl: rawTrades[base + 5],
      returnPct: rawTrades[base + 6],
      reason: rawTrades[base + 7] === 1 ? "STOP" : rawTrades[base + 7] === 2 ? "TARGET" : "SIGNAL",
    });
  }

  // Strictly Causal Walk-Forward Forecast
  const fc = forecastCfg || {};
  const horizon = Number(fc.horizon ?? 14);
  const fSteps = wasm.runWalkForwardForecast(horizon, Number(fc.ridgeLambda ?? 0.02));
  let forecast = null;
  if (fSteps > 0) {
    const rawF = viewF64(wasm.getForecastPtr(), fSteps * 5);
    const metaF = viewF64(wasm.getForecastMetaPtr(), 16);
    const points = [];
    for (let s = 0; s < fSteps; s++) {
      const b = s * 5;
      points.push({ mid: rawF[b], up1: rawF[b + 1], lo1: rawF[b + 2], up2: rawF[b + 3], lo2: rawF[b + 4] });
    }
    forecast = {
      horizon: fSteps,
      points,
      pUpPct: metaF[0],
      expectedReturnPct: metaF[1],
      annualizedVolPct: metaF[2],
      oosAccuracyPct: metaF[3],
      oosBrier: metaF[4],
      oosSamples: Math.round(metaF[5]),
      kalmanVelocityPct: metaF[6],
      barVolPct: metaF[7],
      featureWeights: Array.from(metaF.slice(8, 16)),
    };
  }

  let sweep = null;
  if (runSweep) {
    const s0 = performance.now();
    const grid = 14;
    const buyMin = 5; const buyMax = 70;
    const sellMin = -70; const sellMax = -5;
    const g = wasm.runThresholdSweep(
      buyMin, buyMax, sellMin, sellMax, grid,
      bt.allowShort ? 1 : 0, Number(bt.initialCapital ?? 100000), Number(bt.positionPct ?? 100),
      Number(bt.stopLossPct ?? 0), Number(bt.takeProfitPct ?? 0),
      Number(bt.commissionBps ?? 1), Number(bt.slippageBps ?? 2), Number(bt.barsPerYear ?? 252)
    );
    const rawS = viewF64(wasm.getSweepPtr(), g * g * 4);
    const cells = [];
    const buyStep = (buyMax - buyMin) / (g - 1);
    const sellStep = (sellMax - sellMin) / (g - 1);
    let bestQualified = null;
    for (let r = 0; r < g; r++) {
      for (let c = 0; c < g; c++) {
        const idx = (r * g + c) * 4;
        const cell = {
          r, c,
          buyThresh: Math.round(buyMin + r * buyStep),
          sellThresh: Math.round(sellMin + c * sellStep),
          sharpe: rawS[idx],
          totalReturnPct: rawS[idx + 1],
          maxDDPct: rawS[idx + 2],
          numTrades: Math.round(rawS[idx + 3]),
        };
        cells.push(cell);
        if (cell.numTrades >= 5 && (!bestQualified || cell.sharpe > bestQualified.sharpe)) bestQualified = cell;
      }
    }
    sweep = {
      grid: g, buyMin, buyMax, sellMin, sellMax, cells,
      best: bestQualified,
      minTradesUsed: 5,
      elapsedMs: performance.now() - s0,
    };
  }

  let monteCarlo = null;
  if (runMc && tradeCount >= 2) {
    const m0 = performance.now();
    const iters = 1000;
    const steps = wasm.runMonteCarlo(iters, Number(bt.initialCapital ?? 100000), 0x51a7c0de);
    if (steps > 0) {
      const rawM = viewF64(wasm.getMcPtr(), steps * 5 + 4);
      const bands = [];
      for (let s = 0; s < steps; s++) {
        const b = s * 5;
        bands.push({ p5: rawM[b], p25: rawM[b + 1], p50: rawM[b + 2], p75: rawM[b + 3], p95: rawM[b + 4] });
      }
      const mo = steps * 5;
      monteCarlo = {
        iterations: iters,
        horizonTrades: steps - 1,
        bands,
        medianFinal: rawM[mo],
        p5Final: rawM[mo + 1],
        p95MaxDDPct: rawM[mo + 2],
        probLoss20Pct: rawM[mo + 3],
        elapsedMs: performance.now() - m0,
      };
    }
  }

  return {
    elapsedMs: performance.now() - t0,
    ruleResults,
    score,
    backtest: { equity, bhEquity, drawdown, metrics, trades },
    forecast,
    sweep,
    monteCarlo,
  };
}

// ============================================================================
// BATCH MULTI-STRATEGY TOURNAMENT + STRICTLY CAUSAL CONSENSUS ENSEMBLES
// ============================================================================
function evaluateTournament({ strategies, backtestCfg }) {
  const t0 = performance.now();
  const n = currentN;
  const bt = backtestCfg || {};
  const results = [];
  const sigCache = new Map();

  for (const strat of strategies) {
    wasm.resetComposite();
    for (const r of strat.rules) {
      if (!r.enabled) continue;
      const p1 = Number(r.params?.p1 ?? 0);
      const p2 = Number(r.params?.p2 ?? 0);
      const p3 = Number(r.params?.p3 ?? 0);
      const p4 = Number(r.params?.p4 ?? 0);
      const inv = r.invert ? 1 : 0;
      const cacheKey = `${r.indicatorId}|${p1}|${p2}|${p3}|${p4}|${inv}`;

      let cachedSig = sigCache.get(cacheKey);
      if (!cachedSig) {
        wasm.computeIndicator(r.indicatorId, p1, p2, p3, p4, inv);
        cachedSig = copyF64(wasm.getSigPtr(), n);
        sigCache.set(cacheKey, cachedSig);
      } else {
        viewF64(wasm.getSigPtr(), n).set(cachedSig);
      }

      wasm.accumulateRule(
        Number(r.weight ?? 1),
        Number(r.mode ?? 0),
        Number(r.triggerThresh ?? 0.35),
        Number(r.vetoThresh ?? 0.25)
      );
    }

    wasm.finalizeComposite();
    const scoreArr = copyF64(wasm.getScorePtr(), n);

    const buyT = Number(strat.thresholds?.buy ?? 18);
    const sellT = Number(strat.thresholds?.sell ?? -18);
    wasm.runBacktest(
      buyT, sellT,
      bt.allowShort ? 1 : 0, Number(bt.initialCapital ?? 100000), Number(bt.positionPct ?? 100),
      Number(bt.stopLossPct ?? 0), Number(bt.takeProfitPct ?? 0),
      Number(bt.commissionBps ?? 1), Number(bt.slippageBps ?? 2), Number(bt.barsPerYear ?? 252)
    );

    const metrics = readMetricsObj();
    const eq = copyF64(wasm.getEquityPtr(), n);
    results.push({
      id: strat.id,
      name: strat.name,
      family: strat.family || "custom",
      description: strat.description || "",
      isCustom: Boolean(strat.isCustom),
      ruleCount: strat.rules.filter((x) => x.enabled).length,
      thresholds: strat.thresholds,
      metrics,
      quantRankScore: computeQuantRankScore(metrics),
      score: scoreArr,
      equity: eq,
      sparkline: downsample(eq, 56),
      lastScore: n > 0 ? scoreArr[n - 1] : 0,
    });
  }

  results.sort((a, b) => b.quantRankScore - a.quantRankScore);
  results.forEach((item, idx) => { item.rank = idx + 1; });

  const count = results.length;
  const equalScore = new Float64Array(n);
  const sharpeScore = new Float64Array(n);
  const bullPct = new Float64Array(n);
  const bearPct = new Float64Array(n);
  const agreePct = new Float64Array(n);

  // 1. Equal-Weight Consensus (inherently zero look-ahead!)
  for (let i = 0; i < n; i++) {
    let sumEq = 0;
    let bulls = 0;
    let bears = 0;
    for (let s = 0; s < count; s++) {
      const sc = results[s].score[i];
      sumEq += sc;
      const buyT = results[s].thresholds?.buy ?? 18;
      const sellT = results[s].thresholds?.sell ?? -18;
      if (sc >= buyT) bulls++;
      else if (sc <= sellT) bears++;
    }
    equalScore[i] = count > 0 ? sumEq / count : 0;
    bullPct[i] = count > 0 ? (bulls / count) * 100 : 0;
    bearPct[i] = count > 0 ? (bears / count) * 100 : 0;
    agreePct[i] = count > 0 ? (Math.max(bulls, bears, count - bulls - bears) / count) * 100 : 0;
  }

  // 2. STRICTLY CAUSAL Rolling-Rebalance Sharpe Ensemble (Fixed 60-bar warmup independent of N!)
  const warmup = 60;
  const rebStep = 20;
  let activeWeights = new Float64Array(count).fill(1 / Math.max(1, count));

  for (let i = 0; i < n; i++) {
    if (i >= warmup && (i - warmup) % rebStep === 0 && count > 0) {
      // Evaluate each strategy ONLY over past history [0 .. i)
      const pastSharpes = new Float64Array(count);
      for (let s = 0; s < count; s++) {
        viewF64(wasm.getScorePtr(), n).set(results[s].score);
        const sr = wasm.runBacktestRange(
          0, i,
          Number(results[s].thresholds?.buy ?? 18), Number(results[s].thresholds?.sell ?? -18),
          bt.allowShort ? 1 : 0, Number(bt.initialCapital ?? 100000), Number(bt.positionPct ?? 100),
          Number(bt.stopLossPct ?? 0), Number(bt.takeProfitPct ?? 0),
          Number(bt.commissionBps ?? 1), Number(bt.slippageBps ?? 2), Number(bt.barsPerYear ?? 252)
        );
        pastSharpes[s] = Number.isFinite(sr) ? sr : 0;
      }
      // Softmax / positive-clipped weights favoring past top performers causally
      let wSum = 0;
      for (let s = 0; s < count; s++) {
        const w = Math.exp(Math.max(-2, Math.min(3, pastSharpes[s])) * 0.85);
        activeWeights[s] = w;
        wSum += w;
      }
      if (wSum > 0) for (let s = 0; s < count; s++) activeWeights[s] /= wSum;
    }

    let acc = 0;
    for (let s = 0; s < count; s++) acc += results[s].score[i] * activeWeights[s];
    sharpeScore[i] = acc;
  }

  const runMetaBt = (scArr) => {
    viewF64(wasm.getScorePtr(), n).set(scArr);
    wasm.runBacktest(
      18, -18,
      bt.allowShort ? 1 : 0, Number(bt.initialCapital ?? 100000), Number(bt.positionPct ?? 100),
      Number(bt.stopLossPct ?? 0), Number(bt.takeProfitPct ?? 0),
      Number(bt.commissionBps ?? 1), Number(bt.slippageBps ?? 2), Number(bt.barsPerYear ?? 252)
    );
    const metrics = readMetricsObj();
    const eq = copyF64(wasm.getEquityPtr(), n);
    return { metrics, equity: eq, sparkline: downsample(eq, 56), lastScore: n > 0 ? scArr[n - 1] : 0 };
  };

  const equalEnsemble = {
    id: "__consensus_equal__",
    name: "All-Strategy Consensus (Equal)",
    family: "ensemble",
    description: `Zero-lookahead meta-ensemble averaging all ${count} strategies equally. Fires strongest when Trend, Momentum, Volatility & Volume align.`,
    score: equalScore,
    ...runMetaBt(equalScore),
  };

  const sharpeEnsemble = {
    id: "__consensus_sharpe__",
    name: "Rolling OOS Sharpe Ensemble",
    family: "ensemble",
    description: `Strictly causal meta-ensemble rebalanced every ${rebStep} bars using ONLY prior trailing Sharpe ratios (60-bar warmup).`,
    score: sharpeScore,
    ...runMetaBt(sharpeScore),
  };

  return {
    elapsedMs: performance.now() - t0,
    uniqueIndicatorsCached: sigCache.size,
    strategies: results,
    consensus: {
      equalScore,
      sharpeScore,
      bullPct,
      bearPct,
      agreePct,
      equalEnsemble,
      sharpeEnsemble,
    },
  };
}

// Fast live draft evaluator for Strategy Creator Studio (<1ms)
function previewDraft({ rules, thresholds, backtestCfg, existingScores }) {
  const n = currentN;
  if (!n || !rules?.length) return null;
  wasm.resetComposite();
  for (const r of rules) {
    if (!r.enabled) continue;
    wasm.computeIndicator(
      r.indicatorId,
      Number(r.params?.p1 ?? 0),
      Number(r.params?.p2 ?? 0),
      Number(r.params?.p3 ?? 0),
      Number(r.params?.p4 ?? 0),
      r.invert ? 1 : 0
    );
    wasm.accumulateRule(Number(r.weight ?? 1), Number(r.mode ?? 0), Number(r.triggerThresh ?? 0.35), Number(r.vetoThresh ?? 0.25));
  }
  wasm.finalizeComposite();
  const score = copyF64(wasm.getScorePtr(), n);
  const bt = backtestCfg || {};
  wasm.runBacktest(
    Number(thresholds?.buy ?? 18), Number(thresholds?.sell ?? -18),
    bt.allowShort ? 1 : 0, Number(bt.initialCapital ?? 100000), Number(bt.positionPct ?? 100),
    Number(bt.stopLossPct ?? 0), Number(bt.takeProfitPct ?? 0),
    Number(bt.commissionBps ?? 1), Number(bt.slippageBps ?? 2), Number(bt.barsPerYear ?? 252)
  );
  const metrics = readMetricsObj();
  const quantRankScore = computeQuantRankScore(metrics);
  const eq = copyF64(wasm.getEquityPtr(), n);
  let projectedRank = 1;
  if (Array.isArray(existingScores)) {
    for (const s of existingScores) if (s > quantRankScore) projectedRank++;
  }
  return {
    lastScore: score[n - 1] ?? 0,
    metrics,
    quantRankScore,
    projectedRank,
    totalRanked: (existingScores?.length || 0) + 1,
    sparkline: downsample(eq, 48),
  };
}

// Snapshot current live signal [-1..+1] for all 62 indicators (used in Creator Studio picker)
function snapshotAllIndicators({ catalogDefaults }) {
  const n = currentN;
  if (!n) return {};
  const map = {};
  for (const item of catalogDefaults) {
    wasm.computeIndicator(item.id, item.p1, item.p2, item.p3, item.p4, 0);
    const sig = viewF64(wasm.getSigPtr(), n);
    map[item.key] = sig[n - 1] ?? 0;
  }
  return map;
}

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data;
  try {
    await ensureWasm();
    if (type === "LOAD_BARS") {
      const t0 = performance.now();
      loadBarsIntoWasm(payload.bars);
      self.postMessage({ id, ok: true, result: { count: currentN, elapsedMs: performance.now() - t0 } });
    } else if (type === "EVALUATE") {
      self.postMessage({ id, ok: true, result: runScorePipeline(payload) });
    } else if (type === "EVALUATE_TOURNAMENT") {
      self.postMessage({ id, ok: true, result: evaluateTournament(payload) });
    } else if (type === "PREVIEW_DRAFT") {
      self.postMessage({ id, ok: true, result: previewDraft(payload) });
    } else if (type === "SNAPSHOT_INDICATORS") {
      self.postMessage({ id, ok: true, result: snapshotAllIndicators(payload) });
    } else {
      throw new Error(`Unknown worker command: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
