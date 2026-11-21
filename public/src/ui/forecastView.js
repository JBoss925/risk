import { classifyScore } from "../data/strategies.js";
import { niceTicks, fmtFixed, fmtPct } from "./format.js";

const FEATURE_NAMES = [
  "5-Bar Momentum",
  "20-Bar Momentum",
  "RSI(14) Mean Rev",
  "ATR Vol Regime",
  "Bollinger %B",
  "Volume Z-Score",
  "Kalman Velocity",
  "Active Strategy Score",
];

function drawForecastCanvas(canvas, bars, forecast) {
  if (!canvas || !bars?.length || !forecast?.points?.length) return;
  const w = Math.max(320, Math.floor(canvas.parentElement.getBoundingClientRect().width));
  const h = 320;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, w, h);

  const histLen = Math.min(bars.length, 65);
  const hist = bars.slice(-histLen);
  const pts = forecast.points;
  const total = hist.length + pts.length;

  let minP = Infinity; let maxP = -Infinity;
  for (const b of hist) { if (b.l < minP) minP = b.l; if (b.h > maxP) maxP = b.h; }
  for (const p of pts) { if (p.lo2 < minP) minP = p.lo2; if (p.up2 > maxP) maxP = p.up2; }
  const pad = (maxP - minP) * 0.09 || 1;
  minP -= pad; maxP += pad;

  const padL = 14; const padR = 76; const padT = 18; const padB = 24;
  const plotW = w - padL - padR; const plotH = h - padT - padB;
  const xOf = (i) => padL + ((i + 0.5) / total) * plotW;
  const yOf = (v) => padT + ((maxP - v) / (maxP - minP)) * plotH;
  const candleW = Math.max(2, Math.min(11, (plotW / total) * 0.65));

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  for (const val of niceTicks(minP, maxP, 5)) {
    const y = yOf(val);
    if (y < padT + 4 || y > padT + plotH - 4) continue;
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(w - padR, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillText(`$${val >= 100 && Number.isInteger(val) ? val.toFixed(0) : val.toFixed(2)}`, w - padR + 8, y + 3.5);
  }

  // NOW vertical divider
  const nowX = xOf(hist.length - 1);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.32)"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(nowX, padT); ctx.lineTo(nowX, padT + plotH); ctx.stroke(); ctx.setLineDash([]);

  // Crisp Candlesticks leading into the Forecast Cone
  for (let i = 0; i < hist.length; i++) {
    const b = hist[i];
    const x = xOf(i);
    const clr = b.c >= b.o ? "#10b981" : "#f43f5e";
    ctx.strokeStyle = clr; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yOf(b.h)); ctx.lineTo(Math.round(x) + 0.5, yOf(b.l)); ctx.stroke();
    const yO = yOf(b.o); const yC = yOf(b.c);
    ctx.fillStyle = clr;
    ctx.fillRect(x - candleW * 0.5, Math.min(yO, yC), candleW, Math.max(1.2, Math.abs(yC - yO)));
  }

  // 2-Sigma & 1-Sigma Probability Cones
  const lastY = yOf(hist[hist.length - 1].c);
  ctx.beginPath(); ctx.moveTo(nowX, lastY);
  for (let s = 0; s < pts.length; s++) ctx.lineTo(xOf(hist.length + s), yOf(pts[s].up2));
  for (let s = pts.length - 1; s >= 0; s--) ctx.lineTo(xOf(hist.length + s), yOf(pts[s].lo2));
  ctx.closePath(); ctx.fillStyle = "rgba(99, 102, 241, 0.14)"; ctx.fill();

  ctx.beginPath(); ctx.moveTo(nowX, lastY);
  for (let s = 0; s < pts.length; s++) ctx.lineTo(xOf(hist.length + s), yOf(pts[s].up1));
  for (let s = pts.length - 1; s >= 0; s--) ctx.lineTo(xOf(hist.length + s), yOf(pts[s].lo1));
  ctx.closePath(); ctx.fillStyle = "rgba(56, 189, 248, 0.22)"; ctx.fill();

  ctx.beginPath(); ctx.moveTo(nowX, lastY);
  for (let s = 0; s < pts.length; s++) ctx.lineTo(xOf(hist.length + s), yOf(pts[s].mid));
  ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2.2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);

  const end = pts[pts.length - 1];
  const ex = xOf(total - 1);
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath(); ctx.arc(ex, yOf(end.mid), 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "center";
  ctx.fillText("NOW", nowX, h - 7);
  ctx.fillStyle = "#38bdf8";
  ctx.textAlign = "right";
  ctx.fillText(`+${pts.length} bars`, Math.min(w - padR, ex + 8), h - 7);
  ctx.textAlign = "left";
}

export function renderForecastView(container, {
  symbol,
  activeStrategyName,
  activeScore,
  thresholds,
  bars,
  forecast,
  forecastCfg,
  onUpdateForecastCfg,
  onSendToPaper,
}) {
  if (!forecast) {
    container.innerHTML = `<div class="panel-empty">Need at least 70 bars to run strictly out-of-sample walk-forward forecasting.</div>`;
    return;
  }

  const lastPx = bars[bars.length - 1].c;
  const endPt = forecast.points[forecast.points.length - 1];
  const maxW = Math.max(0.05, ...forecast.featureWeights.map((w) => Math.abs(w)));
  const stratRating = classifyScore(activeScore ?? 0, thresholds);
  const modelBull = forecast.pUpPct >= 52;
  const modelBear = forecast.pUpPct <= 48;
  const stratBull = (activeScore ?? 0) >= thresholds.buy;
  const stratBear = (activeScore ?? 0) <= thresholds.sell;
  const alignment =
    (modelBull && stratBull) || (modelBear && stratBear)
      ? { label: "ALIGNED", cls: "bull" }
      : (modelBull && stratBear) || (modelBear && stratBull)
      ? { label: "DIVERGENT", cls: "bear" }
      : { label: "NEUTRAL", cls: "flat" };

  const featBars = forecast.featureWeights
    .map((w, i) => {
      const pct = Math.min(50, (Math.abs(w) / maxW) * 48);
      const left = w >= 0 ? 50 : 50 - pct;
      const name = FEATURE_NAMES[i];
      return `
        <div class="feat-row">
          <span class="feat-name" title="${i === 7 ? activeStrategyName : name}">${name}</span>
          <div class="strength-track">
            <div class="strength-zero"></div>
            <div class="strength-fill ${w >= 0 ? "pos" : "neg"}" style="left:${left.toFixed(1)}%;width:${pct.toFixed(1)}%"></div>
          </div>
          <span class="mono ${w >= 0 ? "pos" : "neg"}" style="width:54px;text-align:right">${w >= 0 ? "+" : ""}${w.toFixed(3)}</span>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="bt-shell">
      <div class="bt-config-bar card">
        <label>
          <span>Forecast Horizon (${forecastCfg.horizon} bars)</span>
          <input type="range" id="fcHorizon" min="3" max="30" step="1" value="${forecastCfg.horizon}" />
        </label>
        <label>
          <span>L2 Ridge λ (${forecastCfg.ridgeLambda})</span>
          <input type="range" id="fcLambda" min="0.005" max="0.2" step="0.005" value="${forecastCfg.ridgeLambda}" />
        </label>
        <div class="alignment-chip">
          <span class="muted-sm">Strategy vs Model:</span>
          <span class="signal-pill ${alignment.cls}">${alignment.label}</span>
          <span class="mono muted-sm">(${stratRating.short} ${(activeScore ?? 0) >= 0 ? "+" : ""}${(activeScore ?? 0).toFixed(0)})</span>
        </div>
        <button class="btn-ghost-sm" id="fcSendPaperBtn" style="margin-left:auto">Trade in Paper Desk →</button>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">DIRECTIONAL PROBABILITY P(UP)</span>
          <strong class="kpi-val mono ${forecast.pUpPct >= 52 ? "pos" : forecast.pUpPct <= 48 ? "neg" : ""}">${forecast.pUpPct.toFixed(1)}%</strong>
          <span class="kpi-sub mono">Horizon: ${forecast.horizon} bars · Strategy-conditioned</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">EXPECTED TARGET / RETURN</span>
          <strong class="kpi-val mono ${forecast.expectedReturnPct >= 0 ? "pos" : "neg"}">$${endPt.mid.toFixed(2)} (${forecast.expectedReturnPct >= 0 ? "+" : ""}${forecast.expectedReturnPct.toFixed(2)}%)</strong>
          <span class="kpi-sub mono">1σ Range: $${endPt.lo1.toFixed(2)} – $${endPt.up1.toFixed(2)}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">STRICTLY CAUSAL OOS ACCURACY</span>
          <strong class="kpi-val mono ${forecast.oosAccuracyPct >= 52 ? "pos" : ""}">${forecast.oosAccuracyPct.toFixed(1)}%</strong>
          <span class="kpi-sub mono">${forecast.oosSamples} frozen-origin OOS samples · Brier ${forecast.oosBrier.toFixed(3)}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">EWMA VOLATILITY &amp; KALMAN DRIFT</span>
          <strong class="kpi-val mono">${forecast.annualizedVolPct.toFixed(1)}%</strong>
          <span class="kpi-sub mono">Kalman Vel ${forecast.kalmanVelocityPct >= 0 ? "+" : ""}${forecast.kalmanVelocityPct.toFixed(3)}%/bar</span>
        </div>
      </div>

      <div class="card chart-panel">
        <div class="section-mini-head">
          <span>${symbol} CANDLESTICKS + PROBABILISTIC FORECAST CONE · CONDITIONED ON "${(activeStrategyName || "ACTIVE").toUpperCase()}"</span>
          <span class="mono muted">SPOT $${lastPx.toFixed(2)} → 2σ [$${endPt.lo2.toFixed(2)} – $${endPt.up2.toFixed(2)}]</span>
        </div>
        <div class="canvas-box"><canvas id="fcConeCanvas"></canvas></div>
      </div>

      <div class="card">
        <div class="section-mini-head">
          <span>LEARNED CAUSAL FEATURE WEIGHTS (FROZEN-ORIGIN ONLINE LOGISTIC MODEL)</span>
          <span class="mono muted">ZERO LOOK-AHEAD · CAUSAL VOL NORMALIZATION</span>
        </div>
        <div class="feat-list">${featBars}</div>
      </div>
    </div>
  `;

  container.querySelector("#fcHorizon")?.addEventListener("change", (e) =>
    onUpdateForecastCfg?.({ ...forecastCfg, horizon: Number(e.target.value) })
  );
  container.querySelector("#fcLambda")?.addEventListener("change", (e) =>
    onUpdateForecastCfg?.({ ...forecastCfg, ridgeLambda: Number(e.target.value) })
  );
  container.querySelector("#fcSendPaperBtn")?.addEventListener("click", () => onSendToPaper?.());

  requestAnimationFrame(() => drawForecastCanvas(container.querySelector("#fcConeCanvas"), bars, forecast));
}
