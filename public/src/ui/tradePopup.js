// Live Real-Time Chart Trade Recommendation Popup + Open Position Bar + Fortune 100 & Index Universe Scanner

import { INDICATOR_BY_ID } from "../data/indicators.js";
import { classifyScore, DEFAULT_THRESHOLDS } from "../data/strategies.js";
import { MARKET_UNIVERSE, UNIVERSE_GROUPS } from "../data/universe.js";
import { computeConsensusSummary, fmtMoney, fmtPct, cleanZero } from "./format.js";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function roundPx(v) {
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(Math.abs(v) < 1 ? 4 : 2));
}

function fmtPx(v) {
  if (!Number.isFinite(v)) return "—";
  return `$${v.toFixed(Math.abs(v) < 1 ? 4 : 2)}`;
}

export function computeAtr14(bars) {
  const n = bars?.length || 0;
  if (n < 2) return 0;
  const start = Math.max(1, n - 14);
  let sum = 0;
  let cnt = 0;
  for (let i = start; i < n; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    sum += tr;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

export function computeLiveTradeRecommendation({
  symbol,
  bars,
  score,
  thresholds,
  rules,
  ruleResults,
  tournament,
  forecast,
  portfolio,
  riskPct = 1.5,
  allowShort = false,
  activeStrategyName = "Active Strategy",
  isEnsembleMode = false,
}) {
  if (!bars?.length || !score?.length) return null;
  const idx = bars.length - 1;
  const lastBar = bars[idx];
  const entryPx = lastBar.c;
  if (!Number.isFinite(entryPx) || entryPx <= 0) return null;

  const sc = score[idx] ?? 0;
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const rating = classifyScore(sc, th);

  if (rating.id === "hold") return null;

  const isBuy = rating.id === "buy" || rating.id === "strong_buy";
  const pos = portfolio?.state?.positions?.[symbol] || null;
  const eq = portfolio ? portfolio.getEquity({ [symbol]: entryPx }) : { equity: 100000, cash: 100000 };
  const shortAllowed = !!(allowShort && (portfolio ? portfolio.state.allowShort : true));

  const atr = Math.max(entryPx * 0.012, computeAtr14(bars));
  const stopDist = Math.min(entryPx * 0.12, Math.max(entryPx * 0.015, atr * 1.5));
  const targetDist = Math.min(entryPx * 0.25, Math.max(stopDist * 1.65, atr * 2.5));

  let action = null; // 'buy' | 'flatten' | 'short' | 'caution'
  let headline = "";
  let stopLoss = null;
  let takeProfit = null;
  let shares = 0;
  let notional = 0;
  let maxRiskDollars = 0;
  let rrRatio = targetDist / Math.max(1e-6, stopDist);
  let blockedReason = null;

  if (isBuy) {
    if (pos && pos.qty > 0) {
      const currentVal = pos.qty * entryPx;
      if (rating.id !== "strong_buy" || currentVal >= eq.equity * 0.35) return null;
      action = "buy";
      headline = `ADD TO LONG · ${symbol}`;
    } else {
      action = "buy";
      headline = pos && pos.qty < 0 ? `COVER & GO LONG · ${symbol}` : `RECOMMENDED LONG · ${symbol}`;
    }
    stopLoss = roundPx(entryPx - stopDist);
    takeProfit = roundPx(entryPx + targetDist);
    if (!(stopLoss > 0 && stopLoss < entryPx && takeProfit > entryPx)) {
      blockedReason = "Unable to compute valid stop/target for this price level";
    } else {
      const riskDollars = Math.max(0, eq.equity * (riskPct / 100));
      const riskPerShare = entryPx - stopLoss;
      const rawShares = riskPerShare > 0 ? Math.floor(riskDollars / riskPerShare) : 0;
      const maxAffordable = Math.floor((Math.max(0, eq.cash) * 0.995) / entryPx);
      shares = Math.min(maxAffordable, rawShares);
      if (shares < 1) {
        blockedReason = maxAffordable < 1 ? "Insufficient cash to buy 1 share" : `Risk budget (${riskPct}%) below 1-share stop risk`;
      }
      notional = shares * entryPx;
      maxRiskDollars = shares * riskPerShare;
      rrRatio = (takeProfit - entryPx) / Math.max(1e-6, riskPerShare);
    }
  } else {
    if (pos && pos.qty > 0) {
      action = "flatten";
      headline = `EXIT / FLATTEN LONG · ${symbol}`;
      shares = Math.abs(pos.qty);
      notional = shares * entryPx;
      maxRiskDollars = portfolio ? portfolio.getPositionUnrealizedPnl(pos, entryPx) : (entryPx - pos.avgPrice) * pos.qty;
    } else if (pos && pos.qty < 0) {
      return null;
    } else if (shortAllowed) {
      action = "short";
      headline = `RECOMMENDED SHORT · ${symbol}`;
      stopLoss = roundPx(entryPx + stopDist);
      takeProfit = roundPx(entryPx - targetDist);
      if (!(takeProfit > 0 && takeProfit < entryPx && stopLoss > entryPx)) {
        blockedReason = "Unable to compute valid short stop/target for this price level";
      } else {
        const riskDollars = Math.max(0, eq.equity * (riskPct / 100));
        const riskPerShare = stopLoss - entryPx;
        const rawShares = riskPerShare > 0 ? Math.floor(riskDollars / riskPerShare) : 0;
        const maxShortable = Math.floor((Math.max(0, eq.equity) * 0.5) / entryPx);
        shares = Math.min(maxShortable, rawShares);
        if (shares < 1) {
          blockedReason = maxShortable < 1 ? "Insufficient equity margin for 1 short share" : `Risk budget (${riskPct}%) below 1-share stop risk`;
        }
        notional = shares * entryPx;
        maxRiskDollars = shares * riskPerShare;
        rrRatio = (entryPx - takeProfit) / Math.max(1e-6, riskPerShare);
      }
    } else {
      // Strictly respect Long-Only mode — NEVER offer a bypass button that violates allowShort!
      action = "caution";
      headline = `BEARISH CAUTION · ${symbol}`;
      stopLoss = null;
      takeProfit = null;
      shares = 0;
    }
  }

  const drivers = [];
  if (!isEnsembleMode) {
    const resMap = new Map((ruleResults || []).map((r) => [r.uid, r]));
    for (const r of rules || []) {
      if (!r.enabled) continue;
      const rr = resMap.get(r.uid);
      const s = rr?.sig?.[idx] ?? 0;
      if (Math.abs(s) < 0.08) continue;
      const meta = INDICATOR_BY_ID.get(r.indicatorId);
      drivers.push({ label: meta?.shortName || r.key.toUpperCase(), signal: s, contrib: s * r.weight });
    }
    drivers.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  }

  const consensus = tournament?.strategies?.length ? computeConsensusSummary(tournament.strategies, idx) : null;
  const signalKey = `${symbol}|${activeStrategyName}|${lastBar.t}|${action}|${rating.id}`;

  return {
    signalKey,
    symbol,
    action,
    headline,
    strategyName: activeStrategyName,
    score: sc,
    rating,
    entryPx,
    stopLoss,
    takeProfit,
    stopPct: stopLoss ? Math.abs(((stopLoss - entryPx) / entryPx) * 100) : 0,
    targetPct: takeProfit ? Math.abs(((takeProfit - entryPx) / entryPx) * 100) : 0,
    rrRatio,
    shares,
    notional,
    maxRiskDollars,
    riskPct,
    blockedReason,
    drivers: drivers.slice(0, 3),
    consensus,
    forecastPUp: forecast?.pUpPct ?? null,
    barTime: lastBar.t,
    hasPosition: !!pos,
  };
}

export function renderLiveTradePopup(container, {
  rec,
  openPosition = null,
  markPrice = 0,
  visible = true,
  minimized = false,
  riskPct = 1.5,
  onChangeRiskPct,
  onAccept,
  onDecline,
  onEnableShorting,
  onFlattenOpenPosition,
  onToggleMinimize,
}) {
  if (!container) return;

  // If no active signal popup is shown, render a sleek live Open Position quick-manage pill when holding this symbol!
  if (!visible || !rec) {
    container.dataset.popupKey = "";
    if (openPosition && Math.abs(openPosition.qty) > 1e-8) {
      const uPnl = openPosition.unrealizedPnl ?? (markPrice - openPosition.avgPrice) * openPosition.qty;
      const isLong = openPosition.qty > 0;
      container.classList.remove("hidden");
      container.innerHTML = `
        <div class="chart-pos-pill">
          <span class="signal-pill ${isLong ? "bull" : "bear"}">${isLong ? "LONG" : "SHORT"} ${Math.abs(openPosition.qty).toFixed(0)}</span>
          <span class="mono">@ ${fmtPx(openPosition.avgPrice)}</span>
          <span class="mono ${cleanZero(uPnl) > 0 ? "pos" : cleanZero(uPnl) < 0 ? "neg" : ""}" style="font-weight:700">${fmtMoney(uPnl)}</span>
          <button class="btn-ghost-xs danger" id="clpQuickFlattenBtn" title="Close open position and cancel linked OCO brackets">Flatten</button>
        </div>
      `;
      container.querySelector("#clpQuickFlattenBtn")?.addEventListener("click", () => onFlattenOpenPosition?.());
      return;
    }
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  const isBull = rec.action === "buy";
  const toneCls = isBull ? "tone-buy" : "tone-sell";

  if (minimized) {
    container.dataset.popupKey = "";
    container.innerHTML = `
      <button class="chart-popup-pill ${toneCls}" id="chartPopupExpandBtn" title="Open Live Trade Recommendation">
        <span class="dot-live"></span>
        <span><strong>${rec.rating.short}</strong> ${esc(rec.symbol)} · ${rec.action === "buy" ? `Long ${rec.shares} sh` : rec.action === "flatten" ? `Exit ${rec.shares} sh` : rec.action === "short" ? `Short ${rec.shares} sh` : `Stay Flat`}</span>
        <span class="mono" style="opacity:0.85">Open ▾</span>
      </button>
    `;
    container.querySelector("#chartPopupExpandBtn")?.addEventListener("click", () => onToggleMinimize?.(false));
    return;
  }

  const riskPills = [0.5, 1, 1.5, 2.5]
    .map((rp) => `<button class="pill-btn ${Math.abs(riskPct - rp) < 0.01 ? "active" : ""}" data-pop-risk="${rp}">${rp}%</button>`)
    .join("");

  const driverChips = rec.drivers
    .map(
      (d) => `<span class="signal-pill ${d.signal > 0.1 ? "bull" : d.signal < -0.1 ? "bear" : "flat"}">${esc(d.label)} ${d.contrib >= 0 ? "+" : ""}${d.contrib.toFixed(1)}</span>`
    )
    .join("");

  const acceptLabel =
    rec.action === "buy"
      ? `✓ Buy ${rec.shares} sh + SL/TP`
      : rec.action === "flatten"
      ? `✓ Close ${rec.shares} sh`
      : rec.action === "short"
      ? `✓ Short ${rec.shares} sh + SL/TP`
      : `✓ Stay Flat (Acknowledge)`;

  const isNewPopup = container.dataset.popupKey !== rec.signalKey;
  container.dataset.popupKey = rec.signalKey;

  container.innerHTML = `
    <div class="chart-live-popup ${toneCls}${isNewPopup ? " is-entering" : ""}">
      <div class="clp-head">
        <div class="clp-kicker nowrap">
          <span class="dot-live"></span>
          <span>LIVE · ${esc(rec.rating.short)} (${rec.score >= 0 ? "+" : ""}${rec.score.toFixed(1)})</span>
        </div>
        <div style="display:flex;gap:3px">
          <button class="icon-btn" id="clpMinBtn" title="Minimize to badge">–</button>
          <button class="icon-btn" id="clpCloseBtn" title="Decline signal for this bar">✕</button>
        </div>
      </div>

      <div class="clp-title">${esc(rec.headline)}</div>
      <div class="clp-sub muted-sm">
        ${esc(rec.strategyName)}
        ${rec.consensus ? ` · <strong class="mono">${rec.consensus.agreePct}%</strong> (${rec.consensus.bulls}▲/${rec.consensus.bears}▼)` : ""}
        ${Number.isFinite(rec.forecastPUp) ? ` · P(Up) <strong class="mono">${rec.forecastPUp.toFixed(0)}%</strong>` : ""}
      </div>

      ${
        rec.action === "flatten"
          ? `<div class="clp-risk-grid">
              <div><span>CLOSE QTY</span><strong class="mono">${rec.shares.toFixed(2)} sh</strong></div>
              <div><span>MARK PX</span><strong class="mono">${fmtPx(rec.entryPx)}</strong></div>
              <div><span>EST. PNL</span><strong class="mono ${cleanZero(rec.maxRiskDollars) >= 0 ? "pos" : "neg"}">${fmtMoney(rec.maxRiskDollars)}</strong></div>
            </div>`
          : rec.action === "caution"
          ? `<div class="muted-sm" style="padding:7px 9px;border-radius:7px;background:rgba(244,63,94,0.08);border:1px solid rgba(244,63,94,0.22);margin-bottom:8px">
              Bearish regime while flat. Shorting is disabled on Paper Desk — stay in cash or enable shorting to trade bearish setups.
            </div>`
          : `<div class="clp-risk-grid">
              <div><span>ENTRY</span><strong class="mono">${fmtPx(rec.entryPx)}</strong></div>
              <div><span>ATR STOP</span><strong class="mono neg">${fmtPx(rec.stopLoss)} (-${rec.stopPct.toFixed(1)}%)</strong></div>
              <div><span>TARGET (${rec.rrRatio.toFixed(1)}R)</span><strong class="mono pos">${fmtPx(rec.takeProfit)} (+${rec.targetPct.toFixed(1)}%)</strong></div>
            </div>
            <div class="clp-sizing-row">
              <span class="bar-tag">RISK</span>
              <div class="cat-pills">${riskPills}</div>
              <span class="mono muted-sm" style="margin-left:auto">${rec.shares} sh · ${fmtMoney(rec.notional)}</span>
            </div>
            ${rec.blockedReason ? `<div class="neg" style="font-size:10.5px;margin-bottom:7px">⚠ ${esc(rec.blockedReason)}</div>` : ""}`
      }

      ${driverChips ? `<div class="sim-driver-chips" style="margin-bottom:8px">${driverChips}</div>` : ""}

      <div class="clp-actions">
        ${
          rec.action === "caution"
            ? `<button class="btn-ghost-sm" id="clpDeclineBtn">${acceptLabel}</button>
               <button class="btn-ghost-xs" id="clpEnableShortBtn" title="Enable Shorting on Paper Desk to recommend short entries">Enable Short</button>`
            : `<button class="btn-trade ${isBull ? "buy" : "sell"}" id="clpAcceptBtn" ${rec.blockedReason ? "disabled style=\"opacity:0.45;cursor:not-allowed\"" : ""}>${acceptLabel}</button>
               <button class="btn-ghost-sm" id="clpDeclineBtn">Decline</button>`
        }
      </div>
    </div>
  `;

  const popupEl = container.querySelector(".chart-live-popup.is-entering");
  popupEl?.addEventListener("animationend", () => popupEl.classList.remove("is-entering"), { once: true });

  container.querySelector("#clpMinBtn")?.addEventListener("click", () => onToggleMinimize?.(true));
  container.querySelector("#clpCloseBtn")?.addEventListener("click", () => onDecline?.(rec));
  container.querySelector("#clpDeclineBtn")?.addEventListener("click", () => onDecline?.(rec));
  container.querySelector("#clpAcceptBtn")?.addEventListener("click", () => !rec.blockedReason && onAccept?.(rec));
  container.querySelector("#clpEnableShortBtn")?.addEventListener("click", () => onEnableShorting?.());
  container.querySelectorAll("[data-pop-risk]").forEach((b) =>
    b.addEventListener("click", () => onChangeRiskPct?.(Number(b.dataset.popRisk)))
  );
}

// ============================================================================
// BLUE-CHIP, FORTUNE 100 & MAJOR INDEX UNIVERSE BROWSER + LIVE SIGNAL SCANNER
// ============================================================================
export function openUniverseModal({ activeSymbol, activeStrategyName, scanCache = {}, onSelectSymbol, onRunLiveScan }) {
  document.getElementById("universeModal")?.remove();

  let groupFilter = "all";
  let signalFilter = "all"; // 'all' | 'actionable' | 'buys' | 'sells'
  let sortByConviction = false;
  let query = "";
  let scanning = false;

  const overlay = document.createElement("div");
  overlay.id = "universeModal";
  overlay.className = "modal-backdrop";

  const render = () => {
    const q = query.trim().toLowerCase();
    const hasScan = Object.keys(scanCache).length > 0;
    let list = MARKET_UNIVERSE.filter((item) => {
      if (groupFilter !== "all" && item.group !== groupFilter) return false;
      if (q && !item.symbol.toLowerCase().includes(q) && !item.name.toLowerCase().includes(q)) return false;
      const sc = scanCache[item.symbol];
      if (signalFilter === "actionable") return sc && Math.abs(sc.score) >= 18;
      if (signalFilter === "buys") return sc && sc.score >= 18;
      if (signalFilter === "sells") return sc && sc.score <= -18;
      return true;
    });

    if (sortByConviction && hasScan) {
      list = list.slice().sort((a, b) => Math.abs(scanCache[b.symbol]?.score ?? -1) - Math.abs(scanCache[a.symbol]?.score ?? -1));
    }

    const groupBtns = [
      `<button class="pill-btn ${groupFilter === "all" ? "active" : ""}" data-uni-grp="all">All (${MARKET_UNIVERSE.length})</button>`,
      ...UNIVERSE_GROUPS.map((g) => {
        const cnt = MARKET_UNIVERSE.filter((x) => x.group === g.id).length;
        return `<button class="pill-btn ${groupFilter === g.id ? "active" : ""}" data-uni-grp="${g.id}">${g.label} (${cnt})</button>`;
      }),
    ].join("");

    const cards = list
      .map((item) => {
        const sc = scanCache[item.symbol];
        const sigPill = sc
          ? `<span class="signal-pill ${sc.score >= 18 ? "bull" : sc.score <= -18 ? "bear" : "flat"}">${sc.short} ${sc.score >= 0 ? "+" : ""}${sc.score.toFixed(0)}</span>`
          : item.benchmark
          ? `<span class="cat-badge cat-trend">BENCHMARKED</span>`
          : "";
        return `
          <button class="uni-card ${item.symbol === activeSymbol ? "active" : ""}" data-uni-pick="${item.symbol}">
            <div class="uni-card-top">
              <strong class="mono">${esc(item.symbol)}</strong>
              ${sigPill}
            </div>
            <div class="uni-card-name">${esc(item.name)}</div>
            ${sc ? `<div class="mono muted" style="font-size:10px;margin-top:3px">$${sc.price.toFixed(2)} (${fmtPct(sc.chgPct, 1, true)})</div>` : ""}
          </button>
        `;
      })
      .join("");

    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h3>Blue-Chip, Fortune 100 &amp; Index Universe (${MARKET_UNIVERSE.length} Markets)</h3>
            <p class="muted-sm">S&amp;P 500, Nasdaq-100, Dow Jones, Mega-Cap Tech, Visa, Intel, and Fortune 100 leaders. Click any symbol to trade or scan live signals with <strong>${esc(activeStrategyName)}</strong>.</p>
          </div>
          <button class="icon-btn" id="uniCloseBtn">✕</button>
        </div>
        <div class="modal-toolbar">
          <input type="text" id="uniSearchInp" class="search-input" placeholder="Filter NVDA, TSLA, GOOG, V, INTC, SPY, QQQ, DIA…" value="${esc(query)}" />
          <button class="btn-primary-sm" id="uniScanBtn" ${scanning ? "disabled" : ""}>${scanning ? "Scanning live…" : "⚡ Scan Live Signals (26 Flagships)"}</button>
        </div>
        <div style="padding:8px 18px 0;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div class="cat-pills">${groupBtns}</div>
          ${
            hasScan
              ? `<div class="cat-pills">
                  <button class="pill-btn ${signalFilter === "all" ? "active" : ""}" data-uni-sig="all">All Signals</button>
                  <button class="pill-btn ${signalFilter === "actionable" ? "active" : ""}" data-uni-sig="actionable">Actionable</button>
                  <button class="pill-btn ${signalFilter === "buys" ? "active" : ""}" data-uni-sig="buys">Buys ▲</button>
                  <button class="pill-btn ${signalFilter === "sells" ? "active" : ""}" data-uni-sig="sells">Sells ▼</button>
                  <button class="pill-btn ${sortByConviction ? "active" : ""}" id="uniSortConvBtn">Sort |Score|</button>
                </div>`
              : ""
          }
        </div>
        <div class="uni-grid">${cards || `<div class="muted-sm" style="padding:20px">No matching symbols</div>`}</div>
      </div>
    `;

    overlay.querySelector("#uniCloseBtn")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#uniSearchInp")?.addEventListener("input", (e) => {
      query = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = overlay.querySelector("#uniSearchInp");
      inp?.focus();
      inp?.setSelectionRange(pos, pos);
    });
    overlay.querySelectorAll("[data-uni-grp]").forEach((b) =>
      b.addEventListener("click", () => { groupFilter = b.dataset.uniGrp; render(); })
    );
    overlay.querySelectorAll("[data-uni-sig]").forEach((b) =>
      b.addEventListener("click", () => { signalFilter = b.dataset.uniSig; render(); })
    );
    overlay.querySelector("#uniSortConvBtn")?.addEventListener("click", () => { sortByConviction = !sortByConviction; render(); });
    overlay.querySelectorAll("[data-uni-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        onSelectSymbol?.(b.dataset.uniPick);
        overlay.remove();
      })
    );
    overlay.querySelector("#uniScanBtn")?.addEventListener("click", async () => {
      if (scanning || !onRunLiveScan) return;
      scanning = true;
      render();
      try {
        await onRunLiveScan((sym, info) => {
          scanCache[sym] = info;
        });
        sortByConviction = true;
      } finally {
        scanning = false;
        render();
      }
    });
  };

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  render();
  document.body.appendChild(overlay);
}
