import { INDICATOR_BY_ID } from "../data/indicators.js";
import { classifyScore } from "../data/strategies.js";
import { niceTicks, smartTruncate, computeConsensusSummary } from "./format.js";

export const COMPARE_COLORS = ["#38bdf8", "#a78bfa", "#fbbf24", "#f472b6", "#2dd4bf"];

const FAMILY_ORDER = ["trend", "momentum", "reversion", "volatility", "volume", "multi", "custom"];
const FAMILY_SHORT = { trend: "TRD", momentum: "MOM", reversion: "MR", volatility: "VOL", volume: "FLW", multi: "MF", custom: "CST" };

function fmtPrice(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtDate(ms, interval, compact = false) {
  const d = new Date(ms);
  const mon = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  if (interval && (interval.endsWith("m") || interval === "1h")) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return compact ? `${mon} ${day}` : `${mon} ${day} ${hh}:${mm}`;
  }
  return compact ? `${mon} ${day}` : `${mon} ${day}, '${String(d.getFullYear()).slice(-2)}`;
}

function computeHeikinAshi(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haC = (b.o + b.h + b.l + b.c) * 0.25;
    const haO = i === 0 ? (b.o + b.c) * 0.5 : (out[i - 1].o + out[i - 1].c) * 0.5;
    out[i] = { t: b.t, o: haO, h: Math.max(b.h, haO, haC), l: Math.min(b.l, haO, haC), c: haC, v: b.v };
  }
  return out;
}

function scoreToMatrixColor(sc) {
  const s = Math.max(-100, Math.min(100, sc)) / 100;
  if (s > 0.08) {
    const t = Math.min(1, s);
    return `rgba(${Math.round(18 - 2 * t)}, ${Math.round(75 + 125 * t)}, ${Math.round(70 + 60 * t)}, ${0.42 + 0.56 * t})`;
  }
  if (s < -0.08) {
    const t = Math.min(1, -s);
    return `rgba(${Math.round(115 + 130 * t)}, ${Math.round(45 + 15 * t)}, ${Math.round(65 + 30 * t)}, ${0.42 + 0.56 * t})`;
  }
  return "rgba(51, 65, 85, 0.45)";
}

export class QuantChartCanvas {
  constructor(canvas, { onHoverBar, onSelectStrategy } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onHoverBar = onHoverBar;
    this.onSelectStrategy = onSelectStrategy;

    this.bars = [];
    this.haBars = [];
    this.interval = "1d";
    this.activeStrategyId = "";
    this.activeStrategyName = "Active";
    this.rules = [];
    this.ruleResults = [];
    this.score = null;
    this.trades = [];
    this.forecast = null;
    this.consensus = null;
    this.tournamentStrategies = [];
    this.comparedStrategies = [];
    this.thresholds = { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 };

    this.chartStyle = "candles";
    this.showForecast = true;
    this.showSignals = true;
    this.showConsensusHalo = true;
    this.subPaneMode = "matrix"; // Default to signature Strategy Agreement Matrix!

    this.viewStart = 0;
    this.viewCount = 120;
    this.hoverIdx = -1;
    this.mouseX = -1;
    this.mouseY = -1;
    this.dragging = false;
    this.dragMoved = false;
    this.dragStartX = 0;
    this.dragStartView = 0;
    this._matrixHitRows = []; // [{ y0, y1, strategy }]

    this._bindEvents();
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas.parentElement || canvas);
  }

  setData({
    bars,
    interval,
    activeStrategyId,
    activeStrategyName,
    rules,
    ruleResults,
    score,
    trades,
    forecast,
    consensus,
    tournamentStrategies,
    comparedStrategies,
    thresholds,
    resetView = false,
  }) {
    const prevLen = this.bars.length;
    if (bars) { this.bars = bars; this.haBars = computeHeikinAshi(bars); }
    if (interval) this.interval = interval;
    if (activeStrategyId !== undefined) this.activeStrategyId = activeStrategyId;
    if (activeStrategyName) this.activeStrategyName = activeStrategyName;
    if (rules) this.rules = rules;
    if (ruleResults) this.ruleResults = ruleResults;
    if (score !== undefined) this.score = score;
    if (trades !== undefined) this.trades = trades || [];
    if (forecast !== undefined) this.forecast = forecast;
    if (consensus !== undefined) this.consensus = consensus;
    if (tournamentStrategies !== undefined) this.tournamentStrategies = tournamentStrategies || [];
    if (comparedStrategies !== undefined) this.comparedStrategies = comparedStrategies || [];
    if (thresholds) this.thresholds = thresholds;

    if (resetView || prevLen === 0 || this.viewStart >= this.bars.length) {
      const n = this.bars.length;
      this.viewCount = Math.min(Math.max(40, n), 140);
      this.viewStart = Math.max(0, n - this.viewCount);
    }
    this.render();
  }

  setOptions(opts) {
    Object.assign(this, opts);
    this.render();
  }

  resetZoom() {
    const n = this.bars.length;
    this.viewCount = Math.min(Math.max(40, n), 140);
    this.viewStart = Math.max(0, n - this.viewCount);
    this.render();
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const n = this.bars.length;
      if (n < 10) return;
      const rect = c.getBoundingClientRect();
      const padL = 38;
      const plotW = Math.max(100, rect.width - padL - 72);
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - padL) / plotW));
      const anchor = this.viewStart + frac * this.viewCount;
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      const nextCount = Math.min(Math.max(24, this.viewCount * factor), Math.max(n + 20, 60));
      this.viewCount = nextCount;
      this.viewStart = Math.max(0, Math.min(n - 10, anchor - frac * nextCount));
      this.render();
    }, { passive: false });

    c.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.dragStartX = e.clientX;
      this.dragStartView = this.viewStart;
      c.style.cursor = "grabbing";
    });

    window.addEventListener("mouseup", () => {
      if (this.dragging) {
        this.dragging = false;
        c.style.cursor = "crosshair";
      }
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const rect = c.getBoundingClientRect();
      const dx = e.clientX - this.dragStartX;
      if (Math.abs(dx) > 4) this.dragMoved = true;
      const plotW = Math.max(100, rect.width - 90);
      const deltaBars = (dx / plotW) * this.viewCount;
      const maxStart = Math.max(0, this.bars.length - 12);
      this.viewStart = Math.max(0, Math.min(maxStart, this.dragStartView - deltaBars));
      this.render();
    });

    c.addEventListener("mousemove", (e) => {
      const rect = c.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      this._updateHoverFromMouse(rect.width);
      this.render();
    });

    c.addEventListener("click", (e) => {
      if (this.dragMoved || this.subPaneMode !== "matrix" || !this._matrixHitRows.length) return;
      const rect = c.getBoundingClientRect();
      const my = e.clientY - rect.top;
      const hit = this._matrixHitRows.find((row) => my >= row.y0 && my <= row.y1);
      if (hit?.strategy) this.onSelectStrategy?.(hit.strategy.id);
    });

    c.addEventListener("mouseleave", () => {
      this.mouseX = -1;
      this.mouseY = -1;
      if (this.hoverIdx !== -1) {
        this.hoverIdx = -1;
        this.onHoverBar?.(-1);
      }
      this.render();
    });

    c.addEventListener("dblclick", () => this.resetZoom());
  }

  _updateHoverFromMouse(cssWidth) {
    const padL = 38;
    const padR = 72;
    const plotW = Math.max(100, cssWidth - padL - padR);
    const forecastExtra = this.showForecast && this.forecast?.points?.length ? Math.min(22, this.forecast.points.length + 2) : 0;
    const totalSlots = this.viewCount + forecastExtra;
    const rel = (this.mouseX - padL) / plotW;
    if (rel < 0 || rel > 1 || this.bars.length === 0) {
      if (this.hoverIdx !== -1) {
        this.hoverIdx = -1;
        this.onHoverBar?.(-1);
      }
      return;
    }
    const idx = Math.floor(this.viewStart + rel * totalSlots);
    const clamped = idx >= 0 && idx < this.bars.length ? idx : -1;
    if (clamped !== this.hoverIdx) {
      this.hoverIdx = clamped;
      this.onHoverBar?.(clamped);
    }
  }

  render() {
    const canvas = this.canvas;
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(320, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, w, h);

    const bars = this.chartStyle === "heikin" ? this.haBars : this.bars;
    const n = bars.length;
    if (n === 0) {
      ctx.fillStyle = "#64748b";
      ctx.font = "500 13px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading market data…", w / 2, h / 2);
      return;
    }

    const compact = w < 520;
    // Constant left gutter so switching lower panes NEVER causes horizontal chart jump!
    const padL = compact ? 30 : 38;
    const padR = compact ? 58 : 72;
    const padT = 36;
    const padB = 24;
    const subRatio = this.subPaneMode === "matrix" ? 0.30 : 0.25;
    const subH = Math.max(114, Math.round(h * subRatio));
    const gap = 14;
    const mainH = Math.max(160, h - padT - padB - subH - gap);
    const mainTop = padT;
    const mainBot = mainTop + mainH;
    const subTop = mainBot + gap;
    const subBot = subTop + subH;
    const plotW = w - padL - padR;

    const forecastPts = this.showForecast && this.forecast?.points?.length ? this.forecast.points : [];
    const visibleEndReal = Math.min(n - 1, Math.ceil(this.viewStart + this.viewCount));
    const nearRightEdge = visibleEndReal >= n - 2;
    const forecastExtra = nearRightEdge && forecastPts.length ? Math.min(24, forecastPts.length + 2) : 0;
    const totalSlots = this.viewCount + forecastExtra;

    const startIdx = Math.max(0, Math.floor(this.viewStart));
    const endIdx = Math.min(n - 1, Math.ceil(this.viewStart + this.viewCount));

    const xOf = (idx) => padL + ((idx + 0.5 - this.viewStart) / totalSlots) * plotW;
    const slotW = plotW / totalSlots;
    const candleW = Math.max(1.5, Math.min(18, slotW * 0.68));

    let pMin = Infinity; let pMax = -Infinity;
    for (let i = startIdx; i <= endIdx; i++) {
      if (bars[i].l < pMin) pMin = bars[i].l;
      if (bars[i].h > pMax) pMax = bars[i].h;
    }
    if (nearRightEdge && forecastPts.length) {
      for (const fp of forecastPts) {
        if (fp.lo2 < pMin) pMin = fp.lo2;
        if (fp.up2 > pMax) pMax = fp.up2;
      }
    }
    const pPad = (pMax - pMin) * 0.08 || 1;
    pMin -= pPad; pMax += pPad;
    const yOf = (price) => mainTop + ((pMax - price) / (pMax - pMin)) * mainH;

    // Subtle Consensus Halo: sleek 4px regime ribbon along top edge + very restrained 3.5% ambient tint
    if (this.showConsensusHalo && this.consensus?.bullPct) {
      for (let i = startIdx; i <= endIdx; i++) {
        const bp = this.consensus.bullPct[i];
        const brp = this.consensus.bearPct[i];
        const bx = xOf(i) - slotW * 0.5;
        if (bp >= 65) {
          ctx.fillStyle = "rgba(16, 185, 129, 0.72)";
          ctx.fillRect(bx, mainTop, slotW + 0.5, 3.5);
          ctx.fillStyle = "rgba(16, 185, 129, 0.032)";
          ctx.fillRect(bx, mainTop + 3.5, slotW + 0.5, mainH - 3.5);
        } else if (brp >= 65) {
          ctx.fillStyle = "rgba(244, 63, 94, 0.72)";
          ctx.fillRect(bx, mainTop, slotW + 0.5, 3.5);
          ctx.fillStyle = "rgba(244, 63, 94, 0.032)";
          ctx.fillRect(bx, mainTop + 3.5, slotW + 0.5, mainH - 3.5);
        }
      }
    }

    // Nice Round Y-Axis Grid Ticks
    const ticks = niceTicks(pMin, pMax, compact ? 4 : 5);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
    ctx.lineWidth = 1;
    ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "left";
    for (const val of ticks) {
      const y = yOf(val);
      if (y < mainTop + 6 || y > mainBot - 6) continue;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(w - padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(fmtPrice(val), w - padR + 7, y + 3.5);
    }

    // Subtle volume histogram
    let maxVol = 1;
    for (let i = startIdx; i <= endIdx; i++) if (bars[i].v > maxVol) maxVol = bars[i].v;
    const volH = mainH * 0.13;
    for (let i = startIdx; i <= endIdx; i++) {
      const b = bars[i];
      const vh = (b.v / maxVol) * volH;
      ctx.fillStyle = b.c >= b.o ? "rgba(16, 185, 129, 0.11)" : "rgba(244, 63, 94, 0.11)";
      ctx.fillRect(xOf(i) - candleW * 0.5, mainBot - vh, candleW, vh);
    }

    // Main pane clipped drawing
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, mainTop, plotW, mainH);
    ctx.clip();

    const activeIdx = this.hoverIdx >= 0 ? this.hoverIdx : n - 1;
    const resultMap = new Map(this.ruleResults.map((r) => [r.uid, r]));
    const overlayLegend = [];

    for (const rule of this.rules) {
      if (!rule.enabled || !rule.showOnChart) continue;
      const meta = INDICATOR_BY_ID.get(rule.indicatorId);
      if (!meta || meta.placement !== "overlay") continue;
      const res = resultMap.get(rule.uid);
      if (!res) continue;

      overlayLegend.push({
        label: meta.shortName,
        color: meta.lines[0]?.color || "#38bdf8",
        val: meta.formatValue(res.lines.map((a) => a[activeIdx])),
      });

      if (["bbands", "keltner", "vwap", "stderr_bands", "pivots"].includes(meta.key) && res.lines[1] && res.lines[2]) {
        const up = res.lines[1]; const lo = res.lines[2];
        ctx.beginPath();
        let started = false;
        for (let i = startIdx; i <= endIdx; i++) {
          if (!Number.isFinite(up[i]) || !Number.isFinite(lo[i])) continue;
          if (!started) { ctx.moveTo(xOf(i), yOf(up[i])); started = true; } else ctx.lineTo(xOf(i), yOf(up[i]));
        }
        for (let i = endIdx; i >= startIdx; i--) {
          if (!Number.isFinite(up[i]) || !Number.isFinite(lo[i])) continue;
          ctx.lineTo(xOf(i), yOf(lo[i]));
        }
        ctx.closePath();
        ctx.fillStyle = meta.key === "vwap" ? "rgba(251, 191, 36, 0.05)" : "rgba(129, 140, 248, 0.065)";
        ctx.fill();
      } else if (meta.key === "ichimoku" && res.lines[2] && res.lines[3]) {
        const spanA = res.lines[2]; const spanB = res.lines[3];
        for (let i = Math.max(startIdx, 1); i <= endIdx; i++) {
          if (!Number.isFinite(spanA[i]) || !Number.isFinite(spanB[i]) || !Number.isFinite(spanA[i - 1]) || !Number.isFinite(spanB[i - 1])) continue;
          ctx.beginPath();
          ctx.moveTo(xOf(i - 1), yOf(spanA[i - 1])); ctx.lineTo(xOf(i), yOf(spanA[i]));
          ctx.lineTo(xOf(i), yOf(spanB[i])); ctx.lineTo(xOf(i - 1), yOf(spanB[i - 1]));
          ctx.closePath();
          ctx.fillStyle = spanA[i] >= spanB[i] ? "rgba(16, 185, 129, 0.11)" : "rgba(244, 63, 94, 0.11)";
          ctx.fill();
        }
      }

      meta.lines.forEach((lineMeta, li) => {
        const arr = res.lines[li];
        if (!arr) return;
        if (lineMeta.splitByDir && res.lines[1]) {
          const dir = res.lines[1];
          ctx.lineWidth = 1.7;
          for (let i = Math.max(startIdx + 1, 1); i <= endIdx; i++) {
            if (!Number.isFinite(arr[i]) || !Number.isFinite(arr[i - 1])) continue;
            ctx.strokeStyle = dir[i] > 0 ? "#10b981" : "#f43f5e";
            ctx.beginPath(); ctx.moveTo(xOf(i - 1), yOf(arr[i - 1])); ctx.lineTo(xOf(i), yOf(arr[i])); ctx.stroke();
          }
          return;
        }
        if (lineMeta.style === "dots") {
          const dir = res.lines[1];
          for (let i = startIdx; i <= endIdx; i++) {
            if (!Number.isFinite(arr[i])) continue;
            ctx.fillStyle = dir && dir[i] < 0 ? "#fb7185" : "#34d399";
            ctx.beginPath(); ctx.arc(xOf(i), yOf(arr[i]), Math.max(1.5, Math.min(3, candleW * 0.28)), 0, Math.PI * 2); ctx.fill();
          }
          return;
        }
        ctx.strokeStyle = lineMeta.color;
        ctx.lineWidth = lineMeta.band ? 1.1 : 1.45;
        if (lineMeta.band) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        let started = false;
        for (let i = startIdx; i <= endIdx; i++) {
          if (!Number.isFinite(arr[i])) continue;
          if (!started) { ctx.moveTo(xOf(i), yOf(arr[i])); started = true; } else ctx.lineTo(xOf(i), yOf(arr[i]));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    // Candles or Area
    if (this.chartStyle === "area") {
      const grad = ctx.createLinearGradient(0, mainTop, 0, mainBot);
      grad.addColorStop(0, "rgba(99, 102, 241, 0.28)");
      grad.addColorStop(1, "rgba(99, 102, 241, 0.0)");
      ctx.beginPath();
      for (let i = startIdx; i <= endIdx; i++) i === startIdx ? ctx.moveTo(xOf(i), yOf(bars[i].c)) : ctx.lineTo(xOf(i), yOf(bars[i].c));
      ctx.strokeStyle = "#818cf8"; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(xOf(endIdx), mainBot); ctx.lineTo(xOf(startIdx), mainBot); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
    } else {
      for (let i = startIdx; i <= endIdx; i++) {
        const b = bars[i]; const x = xOf(i);
        const color = b.c >= b.o ? "#10b981" : "#f43f5e";
        ctx.strokeStyle = color; ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yOf(b.h)); ctx.lineTo(Math.round(x) + 0.5, yOf(b.l)); ctx.stroke();
        const yO = yOf(b.o); const yC = yOf(b.c);
        ctx.fillStyle = color;
        ctx.fillRect(x - candleW * 0.5, Math.min(yO, yC), candleW, Math.max(1.2, Math.abs(yC - yO)));
      }
    }

    // Forecast Probability Cone
    if (nearRightEdge && forecastPts.length) {
      const lastX = xOf(n - 1); const lastY = yOf(bars[n - 1].c);
      ctx.beginPath(); ctx.moveTo(lastX, lastY);
      for (let s = 0; s < forecastPts.length; s++) ctx.lineTo(xOf(n + s), yOf(forecastPts[s].up2));
      for (let s = forecastPts.length - 1; s >= 0; s--) ctx.lineTo(xOf(n + s), yOf(forecastPts[s].lo2));
      ctx.closePath(); ctx.fillStyle = "rgba(99, 102, 241, 0.11)"; ctx.fill();

      ctx.beginPath(); ctx.moveTo(lastX, lastY);
      for (let s = 0; s < forecastPts.length; s++) ctx.lineTo(xOf(n + s), yOf(forecastPts[s].up1));
      for (let s = forecastPts.length - 1; s >= 0; s--) ctx.lineTo(xOf(n + s), yOf(forecastPts[s].lo1));
      ctx.closePath(); ctx.fillStyle = "rgba(56, 189, 248, 0.18)"; ctx.fill();

      ctx.beginPath(); ctx.moveTo(lastX, lastY);
      for (let s = 0; s < forecastPts.length; s++) ctx.lineTo(xOf(n + s), yOf(forecastPts[s].mid));
      ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);

      const endPt = forecastPts[forecastPts.length - 1];
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath(); ctx.arc(xOf(n + forecastPts.length - 1), yOf(endPt.mid), 3.5, 0, Math.PI * 2); ctx.fill();
    }

    // Strategy Trade Markers
    if (this.showSignals && this.trades.length) {
      for (const t of this.trades) {
        if (t.entryIdx >= startIdx && t.entryIdx <= endIdx) {
          const x = xOf(t.entryIdx); const isLong = t.side === "LONG";
          const y = isLong ? yOf(bars[t.entryIdx].l) + 12 : yOf(bars[t.entryIdx].h) - 12;
          ctx.fillStyle = isLong ? "#34d399" : "#fb7185";
          ctx.beginPath();
          if (isLong) { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x + 5, y + 3); }
          else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3); }
          ctx.closePath(); ctx.fill();
        }
        if (t.exitIdx >= startIdx && t.exitIdx <= endIdx) {
          const x = xOf(t.exitIdx); const isLong = t.side === "LONG";
          const y = isLong ? yOf(bars[t.exitIdx].h) - 10 : yOf(bars[t.exitIdx].l) + 10;
          ctx.strokeStyle = t.pnl >= 0 ? "#34d399" : "#fb7185"; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    // Floating Overlay Legend (Top-Left of Main Pane)
    if (overlayLegend.length && !compact) {
      ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
      let lx = padL + 6;
      const ly = mainTop + 16;
      for (const ov of overlayLegend.slice(0, 5)) {
        const txt = `${ov.label} ${ov.val}`;
        const tw = ctx.measureText(txt).width + 18;
        if (lx + tw > padL + plotW - 10) break;
        ctx.fillStyle = "rgba(11, 14, 20, 0.72)";
        ctx.beginPath(); ctx.roundRect(lx - 4, ly - 10, tw, 15, 4); ctx.fill();
        ctx.fillStyle = ov.color;
        ctx.beginPath(); ctx.arc(lx + 3, ly - 3, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#cbd5e1";
        ctx.textAlign = "left";
        ctx.fillText(txt, lx + 10, ly);
        lx += tw + 6;
      }
    }

    ctx.restore();

    // Last price tag
    const lastBar = bars[n - 1];
    const lastPriceY = yOf(lastBar.c);
    if (lastPriceY >= mainTop && lastPriceY <= mainBot) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.3)"; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(padL, lastPriceY); ctx.lineTo(w - padR, lastPriceY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = lastBar.c >= lastBar.o ? "#059669" : "#e11d48";
      ctx.beginPath(); ctx.roundRect(w - padR + 2, lastPriceY - 9, padR - 5, 18, 4); ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(fmtPrice(lastBar.c), w - padR + 6, lastPriceY + 3.5);
    }

    // Sub-pane divider & render
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, subTop - gap * 0.5); ctx.lineTo(w - padR, subTop - gap * 0.5); ctx.stroke();

    this._matrixHitRows = [];
    this._renderSubPane(ctx, { padL, padR, w, plotW, subTop, subBot, subH, startIdx, endIdx, xOf, slotW, candleW, resultMap, activeIdx, compact });

    // Adaptive X-axis Dates (never overlap even on 390px mobile!)
    ctx.fillStyle = "#64748b";
    ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    const minPxPerLabel = compact ? 74 : 112;
    const maxLabels = Math.max(3, Math.floor(plotW / minPxPerLabel));
    const step = Math.max(1, Math.ceil((endIdx - startIdx + 1) / maxLabels));
    let lastLabelRight = -Infinity;
    for (let i = startIdx; i <= endIdx; i += step) {
      const x = xOf(i);
      const txt = fmtDate(bars[i].t, this.interval, compact);
      const tw = ctx.measureText(txt).width;
      if (x - tw * 0.5 < padL + 4 || x + tw * 0.5 > w - padR - 4) continue;
      if (x - tw * 0.5 < lastLabelRight + 10) continue;
      ctx.fillText(txt, x, h - 7);
      lastLabelRight = x + tw * 0.5;
    }

    // Crosshair + Top OHLCV HUD
    const hb = this.bars[activeIdx];
    const hScore = this.score ? this.score[activeIdx] : 0;
    const rating = classifyScore(hScore, this.thresholds);

    if (this.hoverIdx >= 0 && this.mouseX >= padL && this.mouseX <= w - padR) {
      const cx = Math.round(xOf(this.hoverIdx)) + 0.5;
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)"; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cx, mainTop); ctx.lineTo(cx, subBot); ctx.stroke();
      if (this.mouseY >= mainTop && this.mouseY <= mainBot) {
        const cy = Math.round(this.mouseY) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, cy); ctx.lineTo(w - padR, cy); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Top OHLCV + Single-Source-of-Truth Consensus HUD
    ctx.textAlign = "left";
    ctx.font = "600 10.5px 'JetBrains Mono', ui-monospace, monospace";
    const chg = activeIdx > 0 ? ((hb.c - this.bars[activeIdx - 1].c) / this.bars[activeIdx - 1].c) * 100 : 0;
    let agreeTxt = "";
    if (this.tournamentStrategies.length) {
      const cs = computeConsensusSummary(this.tournamentStrategies, activeIdx);
      agreeTxt = `AGREE ${cs.bullPct}%▲/${cs.bearPct}%▼`;
    }
    const hudItems = compact
      ? [
          { txt: fmtDate(hb.t, this.interval, true), clr: "#94a3b8" },
          { txt: `C ${fmtPrice(hb.c)}`, clr: "#f8fafc" },
          { txt: `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`, clr: chg >= 0 ? "#34d399" : "#fb7185" },
          { txt: `${rating.short} ${hScore >= 0 ? "+" : ""}${hScore.toFixed(0)}`, clr: hScore >= this.thresholds.buy ? "#34d399" : hScore <= this.thresholds.sell ? "#fb7185" : "#94a3b8" },
        ]
      : [
          { txt: fmtDate(hb.t, this.interval), clr: "#94a3b8" },
          { txt: `O ${fmtPrice(hb.o)}`, clr: "#cbd5e1" },
          { txt: `H ${fmtPrice(hb.h)}`, clr: "#cbd5e1" },
          { txt: `L ${fmtPrice(hb.l)}`, clr: "#cbd5e1" },
          { txt: `C ${fmtPrice(hb.c)}`, clr: "#f8fafc" },
          { txt: `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`, clr: chg >= 0 ? "#34d399" : "#fb7185" },
          { txt: `SCORE ${hScore >= 0 ? "+" : ""}${hScore.toFixed(1)} (${rating.short})`, clr: hScore >= this.thresholds.buy ? "#34d399" : hScore <= this.thresholds.sell ? "#fb7185" : "#94a3b8" },
          ...(agreeTxt ? [{ txt: agreeTxt, clr: "#7dd3fc" }] : []),
        ];
    let hx = padL + 2;
    for (const item of hudItems) {
      const tw = ctx.measureText(item.txt).width;
      if (hx + tw > w - padR - 6) break;
      ctx.fillStyle = item.clr;
      ctx.fillText(item.txt, hx, 20);
      hx += tw + 11;
    }
  }

  _renderSubPane(ctx, { padL, padR, w, plotW, subTop, subBot, subH, startIdx, endIdx, xOf, slotW, candleW, resultMap, activeIdx, compact }) {
    ctx.save();
    ctx.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";

    // MODE 0 (SIGNATURE): Strategy × Time Agreement Matrix Heatmap (24+ rows grouped by family!)
    if (this.subPaneMode === "matrix" && this.tournamentStrategies.length) {
      const headerH = 16;
      const bodyTop = subTop + headerH;
      const bodyH = Math.max(60, subH - headerH);

      // Group strategies by family cleanly
      const grouped = [];
      for (const fam of FAMILY_ORDER) {
        const members = this.tournamentStrategies.filter((s) => (s.family || "custom") === fam);
        if (members.length) grouped.push({ fam, members });
      }
      const totalRows = grouped.reduce((a, g) => a + g.members.length, 0);
      const rowH = bodyH / Math.max(1, totalRows);

      let cursorY = bodyTop;
      let hoveredRow = null;

      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, bodyTop, plotW, bodyH);
      ctx.clip();

      const cellsRightX = Math.min(padL + plotW, xOf(endIdx) + slotW * 0.5);
      const cellsW = Math.max(2, cellsRightX - padL);

      for (const grp of grouped) {
        const grpStartY = cursorY;
        for (const strat of grp.members) {
          const y0 = cursorY;
          const y1 = cursorY + rowH;
          this._matrixHitRows.push({ y0, y1, strategy: strat });

          const isHover = this.mouseY >= y0 && this.mouseY <= y1 && this.mouseX >= padL && this.mouseX <= cellsRightX;
          const isActiveRow = strat.id === this.activeStrategyId;
          if (isHover) hoveredRow = { strat, y0, y1 };

          for (let i = startIdx; i <= endIdx; i++) {
            const sc = strat.score[i] ?? 0;
            ctx.fillStyle = scoreToMatrixColor(sc);
            ctx.fillRect(xOf(i) - slotW * 0.5, y0, slotW + 0.5, Math.max(1.2, rowH - 0.6));
          }

          if (isActiveRow) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
            ctx.lineWidth = 1.25;
            ctx.strokeRect(padL + 0.5, y0 + 0.5, cellsW - 1, Math.max(2, rowH - 1));
          } else if (isHover) {
            ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
            ctx.lineWidth = 1;
            ctx.strokeRect(padL + 0.5, y0 + 0.5, cellsW - 1, Math.max(2, rowH - 1));
          }
          cursorY = y1;
        }

        // Crisp family divider line clipped cleanly to the heatmap cell area
        ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(cursorY) + 0.5);
        ctx.lineTo(cellsRightX, Math.round(cursorY) + 0.5);
        ctx.stroke();

        // Family label on left margin
        ctx.restore();
        ctx.fillStyle = "#94a3b8";
        ctx.font = "700 8.5px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textAlign = "right";
        ctx.fillText(FAMILY_SHORT[grp.fam] || grp.fam.slice(0, 3).toUpperCase(), padL - 5, (grpStartY + cursorY) * 0.5 + 3);
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL, bodyTop, plotW, bodyH);
        ctx.clip();
      }
      ctx.restore();

      // Header + interactive hover readout
      ctx.textAlign = "left";
      ctx.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
      if (hoveredRow) {
        const sc = hoveredRow.strat.score[activeIdx] ?? 0;
        const r = classifyScore(sc, hoveredRow.strat.thresholds);
        ctx.fillStyle = "#f8fafc";
        ctx.fillText(
          `#${hoveredRow.strat.rank} ${smartTruncate(hoveredRow.strat.name, compact ? 18 : 34)} · ${r.short} (${sc >= 0 ? "+" : ""}${sc.toFixed(0)}) · Click to activate`,
          padL + 2,
          subTop + 11
        );
      } else {
        ctx.fillStyle = "#7dd3fc";
        ctx.fillText(
          compact ? `AGREEMENT MATRIX (${totalRows})` : `STRATEGY AGREEMENT MATRIX (${totalRows} STRATEGIES × TIME · WHITE OUTLINE = ACTIVE · CLICK ROW)`,
          padL + 2,
          subTop + 11
        );
      }

      // Clean right-edge vertical color scale bar (replaces stray oscillator labels)
      const barX = w - padR + 10;
      const scaleGrad = ctx.createLinearGradient(0, bodyTop, 0, subBot);
      scaleGrad.addColorStop(0, "#10b981");
      scaleGrad.addColorStop(0.5, "#334155");
      scaleGrad.addColorStop(1, "#f43f5e");
      ctx.fillStyle = scaleGrad;
      ctx.fillRect(barX, bodyTop + 2, 6, bodyH - 4);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "500 9px 'JetBrains Mono', ui-monospace, monospace";
      ctx.fillText("+100", barX + 10, bodyTop + 9);
      ctx.fillText("0", barX + 10, bodyTop + bodyH * 0.5 + 3);
      ctx.fillText("-100", barX + 10, subBot - 2);
      ctx.restore();
      return;
    }

    // MODE 1: Cross-Strategy Consensus Ribbon (% Bull vs % Bear)
    if (this.subPaneMode === "consensus" && this.consensus?.bullPct) {
      const yMid = subTop + subH * 0.5;
      const { bullPct, bearPct, equalScore } = this.consensus;
      for (let i = startIdx; i <= endIdx; i++) {
        const x = xOf(i);
        const bh = (bullPct[i] / 100) * (subH * 0.48);
        const brh = (bearPct[i] / 100) * (subH * 0.48);
        ctx.fillStyle = bullPct[i] >= 65 ? "rgba(16, 185, 129, 0.78)" : "rgba(52, 211, 153, 0.4)";
        ctx.fillRect(x - candleW * 0.44, yMid - bh, Math.max(1.2, candleW * 0.88), bh);
        ctx.fillStyle = bearPct[i] >= 65 ? "rgba(244, 63, 94, 0.78)" : "rgba(251, 113, 133, 0.4)";
        ctx.fillRect(x - candleW * 0.44, yMid, Math.max(1.2, candleW * 0.88), brh);
      }
      ctx.beginPath();
      for (let i = startIdx; i <= endIdx; i++) {
        const y = subTop + ((100 - equalScore[i]) / 200) * subH;
        i === startIdx ? ctx.moveTo(xOf(i), y) : ctx.lineTo(xOf(i), y);
      }
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.beginPath(); ctx.moveTo(padL, Math.round(yMid) + 0.5); ctx.lineTo(w - padR, Math.round(yMid) + 0.5); ctx.stroke();

      ctx.fillStyle = "#7dd3fc"; ctx.textAlign = "left";
      ctx.fillText(compact ? "CONSENSUS (% BULL/BEAR)" : "MULTI-STRATEGY CONSENSUS (% BULL ▲ / % BEAR ▼)", padL + 4, subTop + 11);
      ctx.fillStyle = "#34d399"; ctx.fillText("100%▲", w - padR + 6, subTop + 10);
      ctx.fillStyle = "#64748b"; ctx.fillText("0%", w - padR + 6, yMid + 3);
      ctx.fillStyle = "#fb7185"; ctx.fillText("100%▼", w - padR + 6, subBot - 2);
      ctx.restore();
      return;
    }

    // MODE 2: Honest Multi-Strategy Pinned Comparison Overlay (ALWAYS includes Active Strategy + Unanimous Agreement Shading!)
    if (this.subPaneMode === "compare") {
      const yS = (v) => subTop + 16 + ((100 - v) / 200) * (subH - 18);
      const plotted = [
        ...(this.score ? [{ name: this.activeStrategyName, score: this.score, color: "#ffffff", width: 2.2 }] : []),
        ...this.comparedStrategies.slice(0, 4).map((cs, idx) => ({
          name: cs.name,
          score: cs.score,
          color: COMPARE_COLORS[idx % COMPARE_COLORS.length],
          width: 1.45,
        })),
      ];

      // Shade bars where ALL plotted strategies unanimously agree bullish (> +15) or bearish (< -15)!
      if (plotted.length >= 2) {
        for (let i = startIdx; i <= endIdx; i++) {
          let allBull = true; let allBear = true;
          for (const p of plotted) {
            const v = p.score[i] ?? 0;
            if (v < 15) allBull = false;
            if (v > -15) allBear = false;
          }
          if (allBull) {
            ctx.fillStyle = "rgba(16, 185, 129, 0.12)";
            ctx.fillRect(xOf(i) - slotW * 0.5, subTop + 16, slotW + 0.5, subH - 18);
          } else if (allBear) {
            ctx.fillStyle = "rgba(244, 63, 94, 0.12)";
            ctx.fillRect(xOf(i) - slotW * 0.5, subTop + 16, slotW + 0.5, subH - 18);
          }
        }
      }

      // Buy / 0 / Sell bands
      for (const lv of [
        { v: this.thresholds.buy, clr: "rgba(16, 185, 129, 0.28)" },
        { v: 0, clr: "rgba(148, 163, 184, 0.25)" },
        { v: this.thresholds.sell, clr: "rgba(244, 63, 94, 0.28)" },
      ]) {
        const ry = Math.round(yS(lv.v)) + 0.5;
        ctx.strokeStyle = lv.clr;
        ctx.setLineDash(lv.v === 0 ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(padL, ry); ctx.lineTo(w - padR, ry); ctx.stroke();
        ctx.setLineDash([]);
      }

      // Plot curves & clean word-boundary legend
      let legX = padL + 4;
      for (const p of plotted) {
        ctx.strokeStyle = p.color; ctx.lineWidth = p.width;
        ctx.beginPath();
        for (let i = startIdx; i <= endIdx; i++) {
          const y = yS(p.score[i] ?? 0);
          i === startIdx ? ctx.moveTo(xOf(i), y) : ctx.lineTo(xOf(i), y);
        }
        ctx.stroke();

        const curVal = p.score[activeIdx] ?? 0;
        const lbl = `● ${smartTruncate(p.name, compact ? 12 : 17)} ${curVal >= 0 ? "+" : ""}${curVal.toFixed(0)}`;
        const tw = ctx.measureText(lbl).width;
        if (legX + tw < w - padR - 6) {
          ctx.fillStyle = p.color;
          ctx.textAlign = "left";
          ctx.fillText(lbl, legX, subTop + 11);
          legX += tw + 11;
        }
      }

      ctx.fillStyle = "#64748b";
      ctx.fillText("+100", w - padR + 7, subTop + 22);
      ctx.fillText("0", w - padR + 7, yS(0) + 3);
      ctx.fillText("-100", w - padR + 7, subBot - 2);
      ctx.restore();
      return;
    }

    // MODE 3: Active Strategy Conviction [-100..+100]
    if (this.subPaneMode === "score" || !resultMap.has(this.subPaneMode)) {
      const yS = (v) => subTop + ((100 - v) / 200) * subH;
      ctx.fillStyle = "rgba(16, 185, 129, 0.055)";
      ctx.fillRect(padL, subTop, plotW, yS(this.thresholds.buy) - subTop);
      ctx.fillStyle = "rgba(244, 63, 94, 0.055)";
      ctx.fillRect(padL, yS(this.thresholds.sell), plotW, subBot - yS(this.thresholds.sell));

      for (const r of [
        { v: this.thresholds.buy, clr: "rgba(16, 185, 129, 0.35)" },
        { v: 0, clr: "rgba(148, 163, 184, 0.25)" },
        { v: this.thresholds.sell, clr: "rgba(244, 63, 94, 0.35)" },
      ]) {
        const ry = Math.round(yS(r.v)) + 0.5;
        ctx.strokeStyle = r.clr; ctx.setLineDash(r.v === 0 ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(padL, ry); ctx.lineTo(w - padR, ry); ctx.stroke(); ctx.setLineDash([]);
      }

      if (this.score) {
        const y0 = yS(0);
        for (let i = startIdx; i <= endIdx; i++) {
          const v = this.score[i]; const y = yS(v);
          ctx.fillStyle =
            v >= this.thresholds.strongBuy ? "rgba(16, 185, 129, 0.72)"
            : v >= this.thresholds.buy ? "rgba(52, 211, 153, 0.42)"
            : v <= this.thresholds.strongSell ? "rgba(244, 63, 94, 0.72)"
            : v <= this.thresholds.sell ? "rgba(251, 113, 133, 0.42)"
            : "rgba(148, 163, 184, 0.25)";
          ctx.fillRect(xOf(i) - candleW * 0.42, Math.min(y0, y), Math.max(1.2, candleW * 0.84), Math.abs(y - y0));
        }
        ctx.beginPath();
        for (let i = startIdx; i <= endIdx; i++) i === startIdx ? ctx.moveTo(xOf(i), yS(this.score[i])) : ctx.lineTo(xOf(i), yS(this.score[i]));
        ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 1.25; ctx.stroke();
      }

      ctx.fillStyle = "#94a3b8"; ctx.textAlign = "left";
      ctx.fillText(compact ? "CONVICTION (-100..+100)" : "ACTIVE STRATEGY CONVICTION (-100 to +100)", padL + 4, subTop + 11);
      ctx.fillStyle = "#64748b";
      ctx.fillText("+100", w - padR + 7, subTop + 10);
      ctx.fillText("0", w - padR + 7, yS(0) + 3);
      ctx.fillText("-100", w - padR + 7, subBot - 2);
      ctx.restore();
      return;
    }

    // MODE 4: Specific Oscillator Indicator
    const res = resultMap.get(this.subPaneMode);
    const meta = INDICATOR_BY_ID.get(res.indicatorId);
    let minV = Infinity; let maxV = -Infinity;
    if (meta.oscRange) [minV, maxV] = meta.oscRange;
    else {
      for (let li = 0; li < meta.lines.length; li++) {
        const arr = res.lines[meta.lines[li].slot ?? li];
        if (!arr) continue;
        for (let i = startIdx; i <= endIdx; i++) {
          if (Number.isFinite(arr[i])) { if (arr[i] < minV) minV = arr[i]; if (arr[i] > maxV) maxV = arr[i]; }
        }
      }
      if (!Number.isFinite(minV) || minV === maxV) { minV = -1; maxV = 1; }
      const pad = (maxV - minV) * 0.1; minV -= pad; maxV += pad;
    }
    const yO = (v) => subTop + ((maxV - v) / (maxV - minV)) * subH;

    if (meta.refLines) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.25)"; ctx.setLineDash([3, 3]);
      for (const rv of meta.refLines) {
        const ry = Math.round(yO(rv)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, ry); ctx.lineTo(w - padR, ry); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    meta.lines.forEach((lm, li) => {
      const arr = res.lines[lm.slot ?? li];
      if (!arr) return;
      if (lm.style === "histogram") {
        const y0 = yO(0);
        for (let i = startIdx; i <= endIdx; i++) {
          if (!Number.isFinite(arr[i])) continue;
          const y = yO(arr[i]);
          ctx.fillStyle = arr[i] >= 0 ? "rgba(16, 185, 129, 0.55)" : "rgba(244, 63, 94, 0.55)";
          ctx.fillRect(xOf(i) - candleW * 0.4, Math.min(y0, y), Math.max(1.2, candleW * 0.8), Math.abs(y - y0));
        }
      } else {
        ctx.strokeStyle = lm.color; ctx.lineWidth = 1.5; ctx.beginPath();
        let started = false;
        for (let i = startIdx; i <= endIdx; i++) {
          if (!Number.isFinite(arr[i])) continue;
          if (!started) { ctx.moveTo(xOf(i), yO(arr[i])); started = true; } else ctx.lineTo(xOf(i), yO(arr[i]));
        }
        ctx.stroke();
      }
    });

    ctx.fillStyle = "#94a3b8"; ctx.textAlign = "left";
    ctx.fillText(smartTruncate(meta.name.toUpperCase(), compact ? 22 : 42), padL + 4, subTop + 11);
    ctx.fillStyle = "#64748b";
    ctx.fillText(maxV.toFixed(1), w - padR + 7, subTop + 10);
    ctx.fillText(minV.toFixed(1), w - padR + 7, subBot - 2);
    ctx.restore();
  }
}
