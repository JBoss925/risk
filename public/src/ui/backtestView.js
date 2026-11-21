import { COMPARE_COLORS } from "./chartCanvas.js";
import { niceTicks, smartTruncate, fmtFixed, fmtPct, fmtMoney, plural } from "./format.js";

function fmtShortDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function drawEquityCanvas(canvas, equity, bhEquity, drawdown, comparedCurves = []) {
  if (!canvas || !equity?.length) return;
  const parent = canvas.parentElement;
  const w = Math.max(300, Math.floor(parent.getBoundingClientRect().width));
  const h = 285;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, w, h);

  const padL = 12; const padR = 68; const padT = 24; const ddH = 62; const gap = 14;
  const eqH = h - padT - ddH - gap - 12;
  const plotW = w - padL - padR;
  const n = equity.length;

  let minE = Infinity; let maxE = -Infinity;
  for (let i = 0; i < n; i++) {
    if (equity[i] < minE) minE = equity[i];
    if (equity[i] > maxE) maxE = equity[i];
    if (bhEquity[i] < minE) minE = bhEquity[i];
    if (bhEquity[i] > maxE) maxE = bhEquity[i];
  }
  for (const cc of comparedCurves) {
    if (!cc.equity) continue;
    for (let i = 0; i < Math.min(n, cc.equity.length); i++) {
      if (cc.equity[i] < minE) minE = cc.equity[i];
      if (cc.equity[i] > maxE) maxE = cc.equity[i];
    }
  }
  const pad = (maxE - minE) * 0.08 || 1000;
  minE -= pad; maxE += pad;

  const xOf = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
  const yE = (v) => padT + ((maxE - v) / (maxE - minE)) * eqH;

  // Shade final 30% Held-Out OOS Window subtly
  const oosStart = Math.floor(n * 0.7);
  ctx.fillStyle = "rgba(56, 189, 248, 0.045)";
  ctx.fillRect(xOf(oosStart), padT, xOf(n - 1) - xOf(oosStart), eqH);
  ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(xOf(oosStart), padT); ctx.lineTo(xOf(oosStart), padT + eqH); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#7dd3fc";
  ctx.font = "600 9.5px 'JetBrains Mono', ui-monospace, monospace";
  ctx.fillText("30% OOS", xOf(oosStart) + 5, padT + 12);

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  for (const val of niceTicks(minE, maxE, 4)) {
    const y = yE(val);
    if (y < padT + 4 || y > padT + eqH - 4) continue;
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(w - padR, Math.round(y) + 0.5); ctx.stroke();
    const lbl = Math.abs(val) >= 1000 ? `$${(val / 1000).toFixed(val % 1000 === 0 ? 0 : 1)}k` : `$${val.toFixed(0)}`;
    ctx.fillText(lbl, w - padR + 8, y + 3);
  }

  ctx.strokeStyle = "rgba(148, 163, 184, 0.55)"; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
  ctx.beginPath();
  for (let i = 0; i < n; i++) i === 0 ? ctx.moveTo(xOf(i), yE(bhEquity[i])) : ctx.lineTo(xOf(i), yE(bhEquity[i]));
  ctx.stroke(); ctx.setLineDash([]);

  let legX = padL + 4;
  ctx.fillStyle = "#10b981"; ctx.fillText("● Active", legX, 14); legX += 64;
  ctx.fillStyle = "#94a3b8"; ctx.fillText("--- B&H", legX, 14); legX += 58;

  comparedCurves.slice(0, 5).forEach((cc, idx) => {
    if (!cc.equity?.length) return;
    const clr = COMPARE_COLORS[idx % COMPARE_COLORS.length];
    ctx.strokeStyle = clr; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < Math.min(n, cc.equity.length); i++) i === 0 ? ctx.moveTo(xOf(i), yE(cc.equity[i])) : ctx.lineTo(xOf(i), yE(cc.equity[i]));
    ctx.stroke();
    if (legX < w - padR - 80) {
      ctx.fillStyle = clr;
      const lbl = `● ${smartTruncate(cc.name, 18)}`;
      ctx.fillText(lbl, legX, 14);
      legX += ctx.measureText(lbl).width + 10;
    }
  });

  const grad = ctx.createLinearGradient(0, padT, 0, padT + eqH);
  grad.addColorStop(0, "rgba(16, 185, 129, 0.22)");
  grad.addColorStop(1, "rgba(16, 185, 129, 0.0)");
  ctx.beginPath();
  for (let i = 0; i < n; i++) i === 0 ? ctx.moveTo(xOf(i), yE(equity[i])) : ctx.lineTo(xOf(i), yE(equity[i]));
  ctx.strokeStyle = "#10b981"; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.lineTo(xOf(n - 1), padT + eqH); ctx.lineTo(xOf(0), padT + eqH); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Underwater Drawdown
  const ddTop = padT + eqH + gap;
  let minDD = -5;
  for (let i = 0; i < n; i++) if (drawdown[i] < minDD) minDD = drawdown[i];
  const yD = (v) => ddTop + (v / minDD) * ddH;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath(); ctx.moveTo(padL, ddTop); ctx.lineTo(w - padR, ddTop); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(xOf(0), ddTop);
  for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yD(drawdown[i]));
  ctx.lineTo(xOf(n - 1), ddTop); ctx.closePath();
  ctx.fillStyle = "rgba(244, 63, 94, 0.28)"; ctx.fill();
  ctx.fillStyle = "#94a3b8"; ctx.fillText("DRAWDOWN", padL + 4, ddTop + 12);
  ctx.fillStyle = "#fb7185"; ctx.fillText(`${minDD.toFixed(1)}%`, w - padR + 8, ddTop + ddH - 2);
}

function drawHeatmapCanvas(canvas, sweep, onPickCell) {
  if (!canvas || !sweep?.cells?.length) return;
  const g = sweep.grid;
  const w = Math.max(260, Math.floor(canvas.parentElement.getBoundingClientRect().width));
  const h = 256;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, w, h);

  const padL = 54; const padB = 38; const padT = 24; const padR = 14;
  const plotW = w - padL - padR; const plotH = h - padT - padB;
  const cellW = plotW / g; const cellH = plotH / g;
  const minN = sweep.minTradesUsed || 5;

  let minS = Infinity; let maxS = -Infinity;
  for (const cell of sweep.cells) {
    if (cell.numTrades < minN) continue;
    if (cell.sharpe < minS) minS = cell.sharpe;
    if (cell.sharpe > maxS) maxS = cell.sharpe;
  }
  if (!Number.isFinite(minS) || minS === maxS) { minS = -1; maxS = 2; }

  // Top Color Legend Bar + Low-N Swatch
  const lgGrad = ctx.createLinearGradient(padL, 0, padL + 96, 0);
  lgGrad.addColorStop(0, "rgb(240, 45, 90)");
  lgGrad.addColorStop(0.5, "rgb(55, 65, 81)");
  lgGrad.addColorStop(1, "rgb(16, 195, 130)");
  ctx.fillStyle = lgGrad;
  ctx.fillRect(padL, 7, 92, 7);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 9.5px 'JetBrains Mono', ui-monospace, monospace";
  ctx.textAlign = "left";
  const srText = `SR ${fmtFixed(minS, 1)}→${fmtFixed(maxS, 1)} · ★ Best (N≥${minN})`;
  ctx.fillText(srText, padL + 98, 14);
  const swX = padL + 98 + ctx.measureText(srText).width + 10;
  if (swX + 58 < w - padR) {
    ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
    ctx.fillRect(swX, 7, 8, 8);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
    ctx.strokeRect(swX + 0.5, 7.5, 7, 7);
    ctx.fillStyle = "#64748b";
    ctx.fillText(`<${minN} tr`, swX + 12, 14);
  }

  for (const cell of sweep.cells) {
    const x = padL + cell.c * cellW;
    const y = padT + (g - 1 - cell.r) * cellH;
    const lowN = cell.numTrades < minN;
    const norm = lowN ? 0.5 : Math.max(0, Math.min(1, (cell.sharpe - minS) / (maxS - minS)));
    let fill;
    if (lowN) fill = "rgba(30, 41, 59, 0.55)";
    else if (norm >= 0.5) {
      const t = (norm - 0.5) * 2;
      fill = `rgba(${Math.round(24 - 8 * t)}, ${Math.round(80 + 115 * t)}, ${Math.round(80 + 50 * t)}, 0.88)`;
    } else {
      const t = (0.5 - norm) * 2;
      fill = `rgba(${Math.round(70 + 170 * t)}, ${Math.round(60 - 15 * t)}, ${Math.round(75 + 15 * t)}, 0.85)`;
    }
    ctx.fillStyle = fill;
    ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, cellW - 1), Math.max(1, cellH - 1));

    if (sweep.best && sweep.best.r === cell.r && sweep.best.c === cell.c) {
      ctx.strokeStyle = "#facc15"; ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
      ctx.fillStyle = "#facc15";
      ctx.font = "700 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("★", x + cellW * 0.5, y + cellH * 0.5 + 4);
    }
  }

  // Explicit Numeric Axis Ticks (Y = Buy Cutoff, X = Sell Cutoff)
  ctx.fillStyle = "#64748b";
  ctx.font = "500 9px 'JetBrains Mono', ui-monospace, monospace";
  const tickIdxs = [0, Math.floor((g - 1) / 3), Math.floor((2 * (g - 1)) / 3), g - 1];
  ctx.textAlign = "right";
  for (const r of tickIdxs) {
    const val = Math.round(sweep.buyMin + (r / Math.max(1, g - 1)) * (sweep.buyMax - sweep.buyMin));
    const cy = padT + (g - 1 - r) * cellH + cellH * 0.5 + 3;
    ctx.fillText(`${val}`, padL - 5, cy);
  }
  ctx.textAlign = "center";
  for (const c of tickIdxs) {
    const val = Math.round(sweep.sellMin + (c / Math.max(1, g - 1)) * (sweep.sellMax - sweep.sellMin));
    const cx = padL + c * cellW + cellW * 0.5;
    ctx.fillText(`${val}`, cx, padT + plotH + 12);
  }

  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 9.5px 'JetBrains Mono', ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("Sell Threshold", padL + plotW * 0.5, h - 6);
  ctx.save();
  ctx.translate(12, padT + plotH * 0.5);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Buy Threshold", 0, 0);
  ctx.restore();

  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor((e.clientX - rect.left - padL) / cellW);
    const r = g - 1 - Math.floor((e.clientY - rect.top - padT) / cellH);
    const found = sweep.cells.find((x) => x.r === r && x.c === c);
    if (found) onPickCell?.(found);
  };
}

function traceSmooth(ctx, pts, xOf, yOf, key, reverse = false) {
  const n = pts.length;
  if (!reverse) {
    ctx.moveTo(xOf(0), yOf(pts[0][key]));
    for (let i = 1; i < n; i++) {
      const mx = (xOf(i - 1) + xOf(i)) * 0.5;
      const my = (yOf(pts[i - 1][key]) + yOf(pts[i][key])) * 0.5;
      ctx.quadraticCurveTo(xOf(i - 1), yOf(pts[i - 1][key]), mx, my);
    }
    ctx.lineTo(xOf(n - 1), yOf(pts[n - 1][key]));
  } else {
    for (let i = n - 1; i >= 1; i--) {
      const mx = (xOf(i) + xOf(i - 1)) * 0.5;
      const my = (yOf(pts[i][key]) + yOf(pts[i - 1][key])) * 0.5;
      ctx.quadraticCurveTo(xOf(i), yOf(pts[i][key]), mx, my);
    }
    ctx.lineTo(xOf(0), yOf(pts[0][key]));
  }
}

function drawMonteCarloCanvas(canvas, mc) {
  if (!canvas || !mc?.bands?.length) return;
  const w = Math.max(260, Math.floor(canvas.parentElement.getBoundingClientRect().width));
  const h = 256;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, w, h);

  const bands = mc.bands;
  const n = bands.length;
  let minV = Infinity; let maxV = -Infinity;
  for (const b of bands) { if (b.p5 < minV) minV = b.p5; if (b.p95 > maxV) maxV = b.p95; }
  const pad = (maxV - minV) * 0.08 || 1000;
  minV -= pad; maxV += pad;

  const padL = 12; const padR = 68; const padT = 16; const padB = 22;
  const plotW = w - padL - padR; const plotH = h - padT - padB;
  const xOf = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
  const yOf = (v) => padT + ((maxV - v) / (maxV - minV)) * plotH;

  ctx.beginPath();
  traceSmooth(ctx, bands, xOf, yOf, "p95", false);
  ctx.lineTo(xOf(n - 1), yOf(bands[n - 1].p5));
  traceSmooth(ctx, bands, xOf, yOf, "p5", true);
  ctx.closePath();
  ctx.fillStyle = "rgba(99, 102, 241, 0.14)";
  ctx.fill();

  ctx.beginPath();
  traceSmooth(ctx, bands, xOf, yOf, "p75", false);
  ctx.lineTo(xOf(n - 1), yOf(bands[n - 1].p25));
  traceSmooth(ctx, bands, xOf, yOf, "p25", true);
  ctx.closePath();
  ctx.fillStyle = "rgba(56, 189, 248, 0.22)";
  ctx.fill();

  ctx.beginPath();
  traceSmooth(ctx, bands, xOf, yOf, "p50", false);
  ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2; ctx.stroke();

  ctx.fillStyle = "#64748b";
  ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
  const last = bands[n - 1];
  ctx.fillText(`p95 $${(last.p95 / 1000).toFixed(0)}k`, w - padR + 5, yOf(last.p95) + 3);
  ctx.fillStyle = "#38bdf8";
  ctx.fillText(`p50 $${(last.p50 / 1000).toFixed(0)}k`, w - padR + 5, yOf(last.p50) + 3);
  ctx.fillStyle = "#fb7185";
  ctx.fillText(`p5  $${(last.p5 / 1000).toFixed(0)}k`, w - padR + 5, yOf(last.p5) + 3);
}

export function renderBacktestView(container, {
  activeStrategyName,
  bars,
  backtest,
  comparedCurves,
  sweep,
  monteCarlo,
  backtestCfg,
  onUpdateBacktestCfg,
  onRunSweepAndMc,
  onApplyOptimalThresholds,
  onSendToPaper,
}) {
  if (!backtest?.metrics) {
    container.innerHTML = `<div class="panel-empty">Load market data to run WebAssembly backtesting.</div>`;
    return;
  }

  const m = backtest.metrics;
  const alpha = m.totalReturnPct - m.bhReturnPct;

  const tradeRows = backtest.trades
    .slice()
    .reverse()
    .slice(0, 80)
    .map((t) => {
      const entryDate = bars[t.entryIdx] ? fmtShortDate(bars[t.entryIdx].t) : `#${t.entryIdx}`;
      const exitDate = bars[t.exitIdx] ? fmtShortDate(bars[t.exitIdx].t) : `#${t.exitIdx}`;
      return `
        <tr>
          <td><span class="signal-pill ${t.side === "LONG" ? "bull" : "bear"}">${t.side}</span></td>
          <td class="mono">${entryDate}</td>
          <td class="mono">${exitDate}</td>
          <td class="mono">$${t.entryPrice.toFixed(2)}</td>
          <td class="mono">$${t.exitPrice.toFixed(2)}</td>
          <td class="mono ${t.pnl >= 0 ? "pos" : "neg"}">${fmtMoney(t.pnl)}</td>
          <td class="mono ${t.returnPct >= 0 ? "pos" : "neg"}">${fmtPct(t.returnPct)}</td>
          <td><span class="reason-tag">${t.reason}</span></td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="bt-shell">
      <div class="bt-config-bar card">
        <label><span>Capital ($)</span><input type="number" class="mono" data-bt="initialCapital" value="${backtestCfg.initialCapital}" step="5000" min="1000" /></label>
        <label><span>Size %</span><input type="number" class="mono" data-bt="positionPct" value="${backtestCfg.positionPct}" step="5" min="10" max="100" /></label>
        <label><span>Stop-Loss %</span><input type="number" class="mono" data-bt="stopLossPct" value="${backtestCfg.stopLossPct || ""}" placeholder="Off" step="0.5" min="0" max="50" /></label>
        <label><span>Take-Profit %</span><input type="number" class="mono" data-bt="takeProfitPct" value="${backtestCfg.takeProfitPct || ""}" placeholder="Off" step="0.5" min="0" max="200" /></label>
        <label><span>Slippage bps</span><input type="number" class="mono" data-bt="slippageBps" value="${backtestCfg.slippageBps}" step="1" min="0" max="50" /></label>
        <label class="bt-check"><input type="checkbox" data-bt-bool="allowShort" ${backtestCfg.allowShort ? "checked" : ""} /><span>Allow Shorting</span></label>
        <div style="display:flex;gap:8px;margin-left:auto">
          <button class="btn-primary-sm" id="runSweepBtn">⚡ Run WASM Sweep + 1,000x MC</button>
          <button class="btn-ghost-sm" id="btSendPaperBtn">Deploy to Paper Desk →</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label" title="${activeStrategyName || "Active"}">FULL-SAMPLE RETURN</span>
          <strong class="kpi-val mono ${m.totalReturnPct >= 0 ? "pos" : "neg"}">${fmtPct(m.totalReturnPct)}</strong>
          <span class="kpi-sub mono">vs B&amp;H ${fmtPct(m.bhReturnPct)} (${fmtPct(alpha)} α) · Exact fees</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">HELD-OUT 30% OOS VALIDATION</span>
          <strong class="kpi-val mono ${(m.oosReturnPct ?? 0) >= 0 ? "pos" : "neg"}">${fmtPct(m.oosReturnPct ?? 0)}</strong>
          <span class="kpi-sub mono">OOS Sharpe ${fmtFixed(m.oosSharpe ?? 0, 2)} · DD -${fmtFixed(m.oosMaxDDPct ?? 0, 1)}% (${plural(m.oosTrades ?? 0, "trade")})</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">SHARPE / MAX DRAWDOWN</span>
          <strong class="kpi-val mono">${fmtFixed(m.sharpe, 2)} <span class="neg" style="font-size:15px">/ -${fmtFixed(m.maxDrawdownPct, 1)}%</span></strong>
          <span class="kpi-sub mono">Sortino ${fmtFixed(m.sortino, 2)} · Exposure ${fmtFixed(m.exposurePct, 0)}%</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">WIN RATE / PROFIT FACTOR</span>
          <strong class="kpi-val mono">${fmtFixed(m.winRatePct, 1)}%</strong>
          <span class="kpi-sub mono">PF ${fmtFixed(m.profitFactor, 2)} · ${plural(m.numTrades, "closed trade")} (avg ${fmtPct(m.avgTradePct)})</span>
        </div>
      </div>

      <div class="card chart-panel">
        <div class="section-mini-head">
          <span>EQUITY CURVE RACE: ACTIVE VS. BUY &amp; HOLD${comparedCurves?.length ? ` + ${comparedCurves.length} PINNED/CONSENSUS` : ""}</span>
          <span class="mono muted">FINAL ${fmtMoney(m.finalEquity)} · SHADED = FINAL 30% OOS</span>
        </div>
        <div class="canvas-box"><canvas id="btEquityCanvas"></canvas></div>
      </div>

      <div class="bt-two-col">
        <div class="card chart-panel">
          <div class="section-mini-head">
            <span>2D THRESHOLD SWEEP (70% TRAIN · IN-SAMPLE SHARPE)</span>
            ${
              sweep?.best
                ? `<span class="mono pos">★ Buy≥${sweep.best.buyThresh} / Sell≤${sweep.best.sellThresh} (SR ${fmtFixed(sweep.best.sharpe, 2)}, N=${sweep.best.numTrades}) · ${sweep.elapsedMs.toFixed(1)}ms</span>`
                : sweep
                ? `<span class="mono muted">No combo met ≥${sweep.minTradesUsed || 5} train trades · ${sweep.elapsedMs.toFixed(1)}ms</span>`
                : `<span class="mono muted">Click Run Sweep above</span>`
            }
          </div>
          ${
            sweep
              ? `<div class="canvas-box"><canvas id="btSweepCanvas"></canvas></div>
                 <div class="muted-sm" style="margin-top:8px">Strictly 70% Train sensitivity map across ${sweep.grid * sweep.grid} WASM backtests (min ${sweep.minTradesUsed} closed trades; final 30% OOS untouched). Click any cell to apply &amp; validate on OOS above.</div>`
              : `<div class="panel-empty-sm">Run 196 threshold combinations over the 70% Train slice in WebAssembly (~2ms) so the final 30% OOS stays uncontaminated.</div>`
          }
        </div>

        <div class="card chart-panel">
          <div class="section-mini-head">
            <span>MONTE CARLO BOOTSTRAP (1,000 PATHS)</span>
            ${
              monteCarlo
                ? `<span class="mono muted">${monteCarlo.horizonTrades < 5 ? `<span class="signal-pill veto" style="margin-right:6px">LOW N</span>` : ""}${monteCarlo.horizonTrades}-trade horizon · p95 DD -${fmtFixed(monteCarlo.p95MaxDDPct, 1)}% · ${monteCarlo.elapsedMs.toFixed(1)}ms</span>`
                : `<span class="mono muted">Portfolio-scaled trade bootstrap</span>`
            }
          </div>
          ${
            monteCarlo
              ? `<div class="canvas-box"><canvas id="btMcCanvas"></canvas></div>
                 <div class="mc-stats mono">
                   <span>Median: <strong>${fmtMoney(monteCarlo.medianFinal)}</strong></span>
                   <span>Worst 5%: <strong class="neg">${fmtMoney(monteCarlo.p5Final)}</strong></span>
                   <span>P(&gt;20% Loss): <strong>${monteCarlo.probLoss20Pct.toFixed(1)}%</strong></span>
                 </div>
                 <div class="muted-sm" style="margin-top:4px">Bootstrap with replacement over portfolio-scaled net trade returns (reflecting ${backtestCfg.positionPct}% sizing &amp; fees).</div>`
              : `<div class="panel-empty-sm">Resamples portfolio-scaled realized trade returns 1,000 times with replacement in WASM to quantify tail drawdown risk.</div>`
          }
        </div>
      </div>

      <div class="card">
        <div class="section-mini-head">
          <span>SIMULATED TRADE LEDGER (NEXT-BAR OPEN · EXACT ENTRY+EXIT COMMISSIONS)</span>
          <span class="mono muted">${backtest.trades.length} CLOSED TRADES</span>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr><th>Side</th><th>Entry</th><th>Exit</th><th>Entry Px</th><th>Exit Px</th><th>Net PnL</th><th>Port Ret</th><th>Exit</th></tr>
            </thead>
            <tbody>
              ${tradeRows || `<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">No closed trades under current thresholds.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll("[data-bt]").forEach((inp) =>
    inp.addEventListener("change", () => onUpdateBacktestCfg?.({ ...backtestCfg, [inp.dataset.bt]: Number(inp.value || 0) }))
  );
  container.querySelectorAll("[data-bt-bool]").forEach((cb) =>
    cb.addEventListener("change", () => onUpdateBacktestCfg?.({ ...backtestCfg, [cb.dataset.btBool]: cb.checked }))
  );
  container.querySelector("#runSweepBtn")?.addEventListener("click", () => onRunSweepAndMc?.());
  container.querySelector("#btSendPaperBtn")?.addEventListener("click", () => onSendToPaper?.());

  requestAnimationFrame(() => {
    drawEquityCanvas(container.querySelector("#btEquityCanvas"), backtest.equity, backtest.bhEquity, backtest.drawdown, comparedCurves);
    if (sweep) drawHeatmapCanvas(container.querySelector("#btSweepCanvas"), sweep, (cell) => onApplyOptimalThresholds?.(cell.buyThresh, cell.sellThresh));
    if (monteCarlo) drawMonteCarloCanvas(container.querySelector("#btMcCanvas"), monteCarlo);
  });
}
