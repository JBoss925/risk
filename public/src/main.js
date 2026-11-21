import { INDICATOR_BY_ID, INDICATOR_CATALOG, createRuleFromCatalog } from "./data/indicators.js";
import {
  DEFAULT_THRESHOLDS,
  POPULAR_TICKERS,
  classifyScore,
  getAllStrategies,
  loadCustomStrategies,
  saveCustomStrategies,
} from "./data/strategies.js";
import { fetchMarketData, searchSymbols, getBarsPerYear, loadDataSettings, AlpacaLiveStream } from "./data/marketData.js";
import { PaperPortfolio } from "./data/paperStore.js";
import { SimSession } from "./data/simEngine.js";
import { RiskEngineClient } from "./engine/engineClient.js";
import { QuantChartCanvas } from "./ui/chartCanvas.js";
import { renderDecisionPanel } from "./ui/decisionPanel.js";
import { renderStrategyBuilder, openIndicatorCatalogModal } from "./ui/strategyBuilder.js";
import { renderStrategyArenaView, openStrategyCreatorModal } from "./ui/strategyArenaView.js";
import { renderBacktestView } from "./ui/backtestView.js";
import { renderForecastView } from "./ui/forecastView.js";
import { renderPaperDeskView } from "./ui/paperDeskView.js";
import { renderSimulatorDeck, renderSimulatorRail } from "./ui/simulatorView.js";
import { computeLiveTradeRecommendation, renderLiveTradePopup, openUniverseModal } from "./ui/tradePopup.js";
import { BENCHMARK_TICKERS, MARKET_UNIVERSE } from "./data/universe.js";
import { computeConsensusSummary, fmtFixed } from "./ui/format.js";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// Parse initial URL hash state (#view?sym=NVDA&strat=quant_composite&pane=matrix)
function parseHashState() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return {};
  const [viewPart, queryPart] = raw.split("?");
  const params = new URLSearchParams(queryPart || "");
  return {
    view: ["terminal", "arena", "backtest", "forecast", "simulator", "paper"].includes(viewPart) ? viewPart : null,
    symbol: params.get("sym")?.toUpperCase() || null,
    strat: params.get("strat") || null,
    pane: params.get("pane") || null,
  };
}

let allStrategies = getAllStrategies();
const urlInit = parseHashState();
const initialStrategy = allStrategies.find((s) => s.id === urlInit.strat) || allStrategies[0];

const state = {
  view: urlInit.view || "terminal",
  railTab: "attribution", // 'attribution' | 'edit'
  symbol: urlInit.symbol || "NVDA",
  interval: "1d",
  range: "1y",
  marketMeta: null,
  fullBars: [],
  bars: [],

  activeStrategyId: urlInit.strat && (urlInit.strat.startsWith("__consensus_") || allStrategies.some((s) => s.id === urlInit.strat))
    ? urlInit.strat
    : initialStrategy.id,
  activeStrategyName: initialStrategy.name,
  rules: initialStrategy.rules.map((x) => ({ ...x, params: { ...x.params } })),
  thresholds: { ...DEFAULT_THRESHOLDS, ...initialStrategy.thresholds },

  tournament: null,
  benchmarks: null,
  expandedBenchmarkIds: new Set(),
  benchFilterSym: "",
  benchSort: "train",
  liveIndicatorSignals: {},
  pinnedIds: ["quant_composite", "trend_rider", "kaufman_adaptive"],
  arenaFilter: "all",
  arenaSort: "quant",
  arenaSearch: "",

  // Live Real-Time Chart Trade Popups & Serialized Versioned Auto-Poll
  livePopupEnabled: true,
  livePopupMinimized: false,
  livePopupRiskPct: 1.5,
  declinedSignals: new Set(),
  livePollMs: 0,
  livePollTimer: null,
  livePollBusy: false,
  livePollSeq: 0,
  scanCache: {},

  backtestCfg: {
    initialCapital: 100000,
    positionPct: 100,
    allowShort: false,
    stopLossPct: 0,
    takeProfitPct: 0,
    commissionBps: 1,
    slippageBps: 2,
  },
  forecastCfg: {
    horizon: 14,
    ridgeLambda: 0.02,
  },

  evalResult: null,
  sweep: null,
  monteCarlo: null,
  hoverIdx: -1,

  // Serialized, causal, next-bar-open Market Replay state
  replay: {
    active: false,
    playing: false,
    busy: false,
    cursor: 0,
    total: 0,
    speedMs: 250,
    timer: null,
    pendingAutoOrder: null, // { side: 'buy'|'sell', stratName } queued at bar t close -> fills bar t+1 OPEN
  },
  // Interactive Live-Chart Paper Trading Simulator state
  sim: {
    seriesKey: "",
    startCursor: 0,
    endCursor: 0,
    cursor: 0,
    pendingBenchmarkWindow: null,
    playing: false,
    busy: false,
    fastForwarding: false,
    speedMs: 700,
    timer: null,
    sizePct: 25,
    stopLossPct: 0,
    takeProfitPct: 0,
    railTab: "indicators", // 'indicators' | 'journal' | 'edit'
    activePrompt: null,
    hoverIdx: -1,
  },
  alpacaStatus: "idle",
};

const engine = new RiskEngineClient();
const portfolio = new PaperPortfolio();
const sim = new SimSession({ startingCash: 100000, feeBps: 1, slippageBps: 2, allowShort: false });
const alpacaStream = new AlpacaLiveStream({
  onStatus: (st) => {
    state.alpacaStatus = st;
    if (st === "live") updateSourceBadge("ALPACA IEX <1s", false);
    if (state.view === "paper") renderActiveView();
  },
  onTick: (tick) => handleLiveTick(tick),
});

const $ = (id) => document.getElementById(id);
const tickerInput = $("tickerInput");
const tickerDropdown = $("tickerDropdown");
const quotePrice = $("quotePrice");
const quoteChange = $("quoteChange");
const quoteName = $("quoteName");
const wasmBadge = $("wasmBadge");
const sourceBadge = $("sourceBadge");
const subPaneSelect = $("subPaneSelect");
const simSubPaneSelect = $("simSubPaneSelect");
const strategySwitcherBtn = $("strategySwitcherBtn");
const strategySwitcherPopover = $("strategySwitcherPopover");
const switcherLabel = $("switcherLabel");
const switcherVerdictPill = $("switcherVerdictPill");
const globalConsensusPill = $("globalConsensusPill");
const globalConsensusText = $("globalConsensusText");
const pinnedCountBadge = $("pinnedCountBadge");

const chart = new QuantChartCanvas($("mainChartCanvas"), {
  onHoverBar: (idx) => {
    state.hoverIdx = idx;
    renderDecisionOnly();
  },
  onSelectStrategy: (id) => {
    selectStrategy(id);
    toast(`Switched to ${state.activeStrategyName}`);
  },
});

const simChart = new QuantChartCanvas($("simChartCanvas"), {
  onHoverBar: (idx) => {
    state.sim.hoverIdx = idx;
    renderSimRailOnly({ hoverOnly: true });
  },
  onSelectStrategy: (id) => {
    selectStrategy(id);
    toast(`Switched to ${state.activeStrategyName}`);
  },
});

if (urlInit.pane) {
  chart.setOptions({ subPaneMode: urlInit.pane });
  simChart.setOptions({ subPaneMode: urlInit.pane });
}

function isEnsembleStrategy(id) {
  return id === "__consensus_equal__" || id === "__consensus_sharpe__";
}

function syncUrlHash() {
  const q = new URLSearchParams({
    sym: state.symbol,
    strat: state.activeStrategyId,
    pane: chart.subPaneMode || "matrix",
  });
  const next = `#${state.view}?${q.toString()}`;
  if (window.location.hash !== next) {
    history.replaceState(null, "", next);
  }
}

function toast(msg, type = "ok") {
  const root = $("toastRoot");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  while (root.children.length > 2) root.firstChild.remove();
  setTimeout(() => el.remove(), 2800);
}

function updateSourceBadge(text, isWarn = false) {
  sourceBadge.textContent = text;
  sourceBadge.classList.toggle("warn", isWarn);
}

function restoreLiveSourceBadge() {
  if (state.alpacaStatus === "live") {
    updateSourceBadge("ALPACA IEX <1s", false);
    return;
  }
  const data = state.marketMeta;
  if (!data) {
    updateSourceBadge("LIVE", false);
    return;
  }
  const isSynth = data.source === "offline-synthetic";
  const badgeText = data.fromIndexedDB ? `CACHE · ${data.source.split(" ")[0].toUpperCase()}` : data.source.toUpperCase();
  updateSourceBadge(badgeText, isSynth);
}

function updateQuoteStrip() {
  const bars = state.bars;
  if (!bars.length) return;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : last;
  const chg = last.c - prev.c;
  const chgPct = prev.c > 0 ? (chg / prev.c) * 100 : 0;
  quotePrice.textContent = `$${last.c.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  quoteChange.textContent = `${chg >= 0 ? "+" : ""}${chg.toFixed(2)} (${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(1)}%)`;
  quoteChange.className = `quote-chg mono ${chg >= 0 ? "pos" : "neg"}`;
  quoteName.textContent = state.marketMeta?.name || state.symbol;
}

function updateMobileVerdictStrip() {
  const el = $("mobileVerdictText");
  if (!el || !state.evalResult?.score?.length) return;
  const sc = state.evalResult.score.at(-1) ?? 0;
  const r = classifyScore(sc, state.thresholds);
  const strats = state.tournament?.strategies;
  const lastIdx = Math.max(0, (state.tournament?.consensus?.equalScore?.length || 1) - 1);
  const summary = strats?.length ? computeConsensusSummary(strats, lastIdx) : null;
  const agreePart = summary ? ` · ${summary.agreePct}% consensus` : "";
  el.innerHTML = `<strong class="${sc >= state.thresholds.buy ? "pos" : sc <= state.thresholds.sell ? "neg" : ""}">${r.label}</strong> ${fmtFixed(sc, 1, true)}${agreePart}`;
}

// ---- Rich Strategy Switcher Popover (⌘K / Click) ----
let switcherQuery = "";
function renderSwitcherPopover() {
  if (strategySwitcherPopover.classList.contains("hidden")) return;
  const rankedList = state.tournament?.strategies || allStrategies.map((s, i) => ({ ...s, rank: i + 1, metrics: null, lastScore: 0 }));
  const eqEns = state.tournament?.consensus?.equalEnsemble;
  const shEns = state.tournament?.consensus?.sharpeEnsemble;

  const q = switcherQuery.trim().toLowerCase();
  const filtered = rankedList.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.family || "").toLowerCase().includes(q));

  const ensItems = [
    { id: "__consensus_equal__", name: "Equal-Weight Consensus", tag: "ENS", score: eqEns?.lastScore ?? 0, sr: eqEns?.metrics?.sharpe },
    { id: "__consensus_sharpe__", name: "Rolling Sharpe Ensemble", tag: "CAUSAL", score: shEns?.lastScore ?? 0, sr: shEns?.metrics?.sharpe },
  ]
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .map((e) => {
      const r = classifyScore(e.score, DEFAULT_THRESHOLDS);
      return `
        <div class="sw-row ${state.activeStrategyId === e.id ? "active" : ""}" data-sw-pick="${e.id}">
          <span class="rank-badge gold mono">★</span>
          <span class="sw-name" style="display:flex;align-items:center;gap:5px"><span style="overflow:hidden;text-overflow:ellipsis">${esc(e.name)}</span><span class="cat-badge cat-custom" style="flex-shrink:0">${e.tag}</span></span>
          <span class="mono muted sw-sr">${Number.isFinite(e.sr) ? `SR ${fmtFixed(e.sr, 2)}` : "—"}</span>
          <span class="signal-pill sw-pill ${e.score >= 18 ? "bull" : e.score <= -18 ? "bear" : "flat"}">${r.short}</span>
          <span class="sw-pin-spacer"></span>
        </div>
      `;
    })
    .join("");

  const stratRows = filtered
    .map((s) => {
      const r = classifyScore(s.lastScore ?? 0, s.thresholds);
      const isPinned = state.pinnedIds.includes(s.id);
      return `
        <div class="sw-row ${state.activeStrategyId === s.id ? "active" : ""}" data-sw-pick="${s.id}">
          <span class="rank-badge ${s.rank === 1 ? "gold" : s.rank === 2 ? "silver" : s.rank === 3 ? "bronze" : ""} mono">#${s.rank}</span>
          <span class="sw-name">${s.isCustom ? "★ " : ""}${esc(s.name)}</span>
          <span class="mono muted sw-sr">${s.metrics ? `SR ${fmtFixed(s.metrics.sharpe, 2)}` : "—"}</span>
          <span class="signal-pill sw-pill ${(s.lastScore ?? 0) >= (s.thresholds?.buy ?? 18) ? "bull" : (s.lastScore ?? 0) <= (s.thresholds?.sell ?? -18) ? "bear" : "flat"}">${r.short}</span>
          <input type="checkbox" class="sw-pin" data-sw-pin="${s.id}" ${isPinned ? "checked" : ""} title="Pin to compare" />
        </div>
      `;
    })
    .join("");

  strategySwitcherPopover.innerHTML = `
    <div class="sw-head">
      <input type="text" id="swSearchInput" class="search-input sm" placeholder="Search 24+ strategies… (use [ / ] to cycle)" value="${esc(switcherQuery)}" />
    </div>
    <div class="sw-list">
      ${ensItems ? `<div class="sw-group-lbl">META-CONSENSUS ENSEMBLES</div>${ensItems}` : ""}
      <div class="sw-group-lbl">RANKED STRATEGIES (${filtered.length})</div>
      ${stratRows || `<div class="muted-sm" style="padding:14px;text-align:center">No matching strategies</div>`}
    </div>
  `;

  const inp = strategySwitcherPopover.querySelector("#swSearchInput");
  inp?.focus();
  inp?.setSelectionRange(switcherQuery.length, switcherQuery.length);
  inp?.addEventListener("input", (e) => { switcherQuery = e.target.value; renderSwitcherPopover(); });
  strategySwitcherPopover.querySelectorAll("[data-sw-pick]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.matches("input")) return;
      selectStrategy(row.dataset.swPick);
      closeSwitcherPopover();
    });
  });
  strategySwitcherPopover.querySelectorAll("[data-sw-pin]").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => togglePinStrategy(cb.dataset.swPin));
  });
}

function openSwitcherPopover() {
  switcherQuery = "";
  strategySwitcherPopover.classList.remove("hidden");
  renderSwitcherPopover();
}

function closeSwitcherPopover() {
  strategySwitcherPopover.classList.add("hidden");
}

function stepRankedStrategy(delta) {
  const list = state.tournament?.strategies || allStrategies;
  if (!list.length) return;
  const idx = list.findIndex((s) => s.id === state.activeStrategyId);
  const nextIdx = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
  selectStrategy(list[nextIdx].id);
  toast(`Activated #${nextIdx + 1} ${list[nextIdx].name}`);
}

function syncGlobalStrategyBar() {
  pinnedCountBadge.textContent = String(state.pinnedIds.length);
  const ranked = state.tournament?.strategies || [];
  const found = ranked.find((s) => s.id === state.activeStrategyId);
  const rankPrefix = found ? `#${found.rank} ` : isEnsembleStrategy(state.activeStrategyId) ? "★ " : "";
  switcherLabel.textContent = `${rankPrefix}${state.activeStrategyName}`;

  const activeScore = state.evalResult?.score?.at(-1);
  if (Number.isFinite(activeScore)) {
    const r = classifyScore(activeScore, state.thresholds);
    switcherVerdictPill.textContent = r.short;
    switcherVerdictPill.className = `signal-pill ${activeScore >= state.thresholds.buy ? "bull" : activeScore <= state.thresholds.sell ? "bear" : "flat"}`;
  }

  if (state.tournament?.strategies?.length) {
    const strats = state.tournament.strategies;
    const cons = state.tournament.consensus;
    const lastIdx = Math.max(0, cons.equalScore.length - 1);
    const sc = cons.equalScore[lastIdx] ?? 0;
    const rating = classifyScore(sc, DEFAULT_THRESHOLDS);
    const summary = computeConsensusSummary(strats, lastIdx);
    globalConsensusText.textContent = `${summary.total}-STRAT: ${rating.short} · ${summary.agreePct}% (${summary.bulls}▲/${summary.bears}▼)`;
    globalConsensusPill.className = `consensus-live-pill ${sc >= 18 ? "bull" : sc <= -18 ? "bear" : ""}`;
  }
  updateMobileVerdictStrip();
}

function syncSubPaneOptions() {
  const oscRules = isEnsembleStrategy(state.activeStrategyId)
    ? []
    : state.rules.filter((r) => {
        const m = INDICATOR_BY_ID.get(r.indicatorId);
        return r.enabled && m && m.placement === "oscillator";
      });
  const html =
    `<option value="matrix">Strategy Agreement Matrix (${allStrategies.length}×Time)</option>` +
    `<option value="consensus">Multi-Strategy Consensus (% Agree)</option>` +
    `<option value="compare">Pinned Strategies Overlay (${state.pinnedIds.length})</option>` +
    `<option value="score">Active Strategy Conviction</option>` +
    oscRules.map((r) => `<option value="${r.uid}">${INDICATOR_BY_ID.get(r.indicatorId).name}</option>`).join("");

  for (const [sel, targetChart] of [
    [subPaneSelect, chart],
    [simSubPaneSelect, simChart],
  ]) {
    if (!sel) continue;
    const current = targetChart.subPaneMode || sel.value;
    sel.innerHTML = html;
    if ([...sel.options].some((o) => o.value === current)) {
      sel.value = current;
    } else {
      sel.value = "matrix";
      targetChart.setOptions({ subPaneMode: "matrix" });
    }
  }
}

function getComparedStrategiesData() {
  if (!state.tournament?.strategies?.length) return [];
  const byId = new Map(state.tournament.strategies.map((s) => [s.id, s]));
  const list = [];
  for (const pid of state.pinnedIds) {
    const found = byId.get(pid);
    if (found && found.id !== state.activeStrategyId) {
      list.push({ id: found.id, name: found.name, score: found.score, equity: found.equity });
    }
  }
  if (!isEnsembleStrategy(state.activeStrategyId) && state.tournament.consensus?.equalEnsemble && list.length < 4) {
    const eq = state.tournament.consensus.equalEnsemble;
    list.push({ id: eq.id, name: "Consensus (All)", score: eq.score, equity: eq.equity });
  }
  return list.slice(0, 4);
}

function togglePinStrategy(id) {
  if (state.pinnedIds.includes(id)) {
    state.pinnedIds = state.pinnedIds.filter((x) => x !== id);
  } else {
    if (state.pinnedIds.length >= 5) {
      toast("Max 5 strategies can be pinned at once", "err");
      return;
    }
    state.pinnedIds = [...state.pinnedIds, id];
  }
  syncGlobalStrategyBar();
  syncSubPaneOptions();
  chart.setData({ comparedStrategies: getComparedStrategiesData() });
  if (state.view === "simulator") simChart.setData({ comparedStrategies: getComparedStrategiesData() });
  if (state.view === "arena" || state.view === "backtest") renderActiveView();
  renderSwitcherPopover();
}

// ---- Strategy Selection & Creator ----
function selectStrategy(id, targetView = null) {
  if (id === "__consensus_equal__") {
    state.activeStrategyId = id;
    state.activeStrategyName = "All-Strategy Consensus (Equal)";
    state.thresholds = { ...DEFAULT_THRESHOLDS };
  } else if (id === "__consensus_sharpe__") {
    state.activeStrategyId = id;
    state.activeStrategyName = "Rolling OOS Sharpe Ensemble";
    state.thresholds = { ...DEFAULT_THRESHOLDS };
  } else {
    const found = allStrategies.find((s) => s.id === id);
    if (!found) return;
    state.activeStrategyId = found.id;
    state.activeStrategyName = found.name;
    state.rules = found.rules.map((x) => ({ ...x, params: { ...x.params } }));
    state.thresholds = { ...DEFAULT_THRESHOLDS, ...found.thresholds };
  }

  state.sweep = null;
  state.monteCarlo = null;
  if (targetView) state.view = targetView;
  syncUrlHash();
  syncGlobalStrategyBar();
  renderComposer();
  runEvaluation().then(() => {
    if (targetView) renderActiveView();
  });
}

async function openCreatorStudio(initialStrategy = null) {
  openStrategyCreatorModal({
    initialStrategy,
    liveSignals: state.liveIndicatorSignals,
    onPreviewDraft: (draft) =>
      engine.previewDraft({
        rules: draft.rules,
        thresholds: draft.thresholds,
        backtestCfg: { ...state.backtestCfg, barsPerYear: getBarsPerYear(state.interval) },
        existingScores: (state.tournament?.strategies || []).map((s) => s.quantRankScore),
      }),
    onSaveStrategy: saveCustomStrategy,
  });
}

async function saveCustomStrategy(draft) {
  const existing = loadCustomStrategies();
  const idx = existing.findIndex((c) => c.id === draft.id);
  const record = {
    id: draft.id,
    name: draft.name,
    family: draft.family || "custom",
    description: draft.description || "",
    isCustom: true,
    thresholds: { ...DEFAULT_THRESHOLDS, ...draft.thresholds },
    rules: draft.rules.map((x) => ({ ...x, params: { ...x.params } })),
  };
  if (idx >= 0) existing[idx] = record;
  else existing.unshift(record);
  saveCustomStrategies(existing);
  allStrategies = getAllStrategies();
  state.activeStrategyId = record.id;
  state.activeStrategyName = record.name;
  state.rules = record.rules.map((x) => ({ ...x, params: { ...x.params } }));
  state.thresholds = { ...record.thresholds };
  if (!state.pinnedIds.includes(record.id)) state.pinnedIds = [record.id, ...state.pinnedIds].slice(0, 5);
  await runTournament();
  await runEvaluation();
  renderComposer();
  renderActiveView();
  toast(`Saved "${record.name}" & ranked on Leaderboard`);
}

async function deleteCustomStrategy(id) {
  const next = loadCustomStrategies().filter((c) => c.id !== id);
  saveCustomStrategies(next);
  allStrategies = getAllStrategies();
  state.pinnedIds = state.pinnedIds.filter((x) => x !== id);
  if (state.activeStrategyId === id) selectStrategy(allStrategies[0].id);
  await runTournament();
  renderActiveView();
  toast("Deleted custom strategy");
}

// ---- Engine Evaluation Pipelines ----
async function refreshIndicatorSnapshot() {
  if (!state.bars.length) return;
  const defaults = INDICATOR_CATALOG.map((item) => {
    const p = { p1: 0, p2: 0, p3: 0, p4: 0 };
    for (const prm of item.params) p[prm.key] = prm.default;
    return { id: item.id, key: item.key, ...p };
  });
  try {
    state.liveIndicatorSignals = await engine.snapshotIndicators(defaults);
  } catch { /* ignore */ }
}

async function runTournament() {
  if (!state.bars.length) return;
  try {
    const tournament = await engine.evaluateTournament({
      strategies: allStrategies,
      backtestCfg: { ...state.backtestCfg, barsPerYear: getBarsPerYear(state.interval) },
    });
    state.tournament = tournament;
    syncGlobalStrategyBar();
    if (state.view === "arena") renderActiveView();
  } catch (err) {
    console.error("[Risk Tournament Error]", err);
  }
}

let evalPending = false;
async function runEvaluation({ runSweep = false, runMc = false, resetChartView = false } = {}) {
  if (!state.bars.length) return;
  if (evalPending && !runSweep) return;
  evalPending = true;
  try {
    let scoreOverride = null;
    if (state.activeStrategyId === "__consensus_equal__" && state.tournament?.consensus?.equalScore) {
      scoreOverride = state.tournament.consensus.equalScore;
    } else if (state.activeStrategyId === "__consensus_sharpe__" && state.tournament?.consensus?.sharpeScore) {
      scoreOverride = state.tournament.consensus.sharpeScore;
    }

    const result = await engine.evaluate({
      scoreOverride,
      rules: state.rules,
      backtestCfg: {
        ...state.backtestCfg,
        buyThresh: state.thresholds.buy,
        sellThresh: state.thresholds.sell,
        barsPerYear: getBarsPerYear(state.interval),
      },
      forecastCfg: state.forecastCfg,
      runSweep,
      runMc,
    });

    state.evalResult = result;
    if (result.sweep) state.sweep = result.sweep;
    if (result.monteCarlo) state.monteCarlo = result.monteCarlo;

    wasmBadge.textContent = `⚡ WASM ${result.elapsedMs.toFixed(1)}ms`;
    syncSubPaneOptions();
    syncGlobalStrategyBar();

    const chartPayload = {
      bars: state.bars,
      interval: state.interval,
      activeStrategyId: state.activeStrategyId,
      activeStrategyName: state.activeStrategyName,
      rules: isEnsembleStrategy(state.activeStrategyId) ? [] : state.rules,
      ruleResults: result.ruleResults,
      score: result.score,
      trades: result.backtest.trades,
      forecast: result.forecast,
      consensus: state.tournament?.consensus || null,
      tournamentStrategies: state.tournament?.strategies || [],
      comparedStrategies: getComparedStrategiesData(),
      thresholds: state.thresholds,
      resetView: resetChartView,
    };

    if (state.view === "simulator") {
      simChart.setData({ ...chartPayload, simFills: sim.fills, simPosition: sim.position, followRight: !resetChartView });
      renderSimDeckOnly();
      renderSimRailOnly();
      renderSimComposer();
    } else {
      const liveOverlay = getLiveChartPositionOverlay(state.symbol);
      chart.setData({ ...chartPayload, simPosition: liveOverlay.simPosition, simFills: liveOverlay.simFills });
      renderDecisionOnly();
      updateLiveChartPopup();
      if (state.view !== "terminal") renderActiveView();
    }
  } catch (err) {
    console.error(err);
    toast(`Engine error: ${err.message}`, "err");
  } finally {
    evalPending = false;
  }
}

function renderDecisionOnly() {
  renderDecisionPanel($("decisionPanelContainer"), {
    symbol: state.symbol,
    activeStrategyName: state.activeStrategyName,
    isEnsembleMode: isEnsembleStrategy(state.activeStrategyId),
    railTab: state.railTab,
    bars: state.bars,
    activeIdx: state.hoverIdx,
    rules: state.rules,
    ruleResults: state.evalResult?.ruleResults || [],
    score: state.evalResult?.score || [],
    thresholds: state.thresholds,
    forecast: state.evalResult?.forecast,
    tournament: state.tournament,
    onQuickTrade: async (side, price) => {
      const qty = Math.max(1, Math.round(5000 / Math.max(1, price)));
      try {
        const t = await portfolio.submitMarketOrder({ symbol: state.symbol, side, qty, price, source: "quick" });
        if (t.brokerStatus === "rejected") toast(`Order rejected by Alpaca (no local fill): ${t.brokerError}`, "err");
        else if (t.brokerStatus === "unknown") toast(`Alpaca outcome unknown (id ${t.clientOrderId}) — reconcile before retrying`, "err");
        else if (t.brokerStatus.startsWith("alpaca:") && t.brokerStatus !== "alpaca:filled") toast(`Submitted to Alpaca (${t.brokerStatus}) — awaiting broker fill`, "ok");
        else toast(`${side.toUpperCase()} ${t.qty} ${t.symbol} @ $${t.price.toFixed(2)}`, "ok");
        if (state.view === "paper") renderActiveView();
      } catch (e) { toast(e.message, "err"); }
    },
    onOpenArena: () => switchView("arena"),
    onSwitchStrategy: (id) => selectStrategy(id),
    onChangeRailTab: (tab) => {
      state.railTab = tab;
      renderDecisionOnly();
      renderComposer();
    },
  });
}

function renderComposer() {
  const commonProps = {
    activeStrategyId: state.activeStrategyId,
    allStrategies,
    isEnsembleMode: isEnsembleStrategy(state.activeStrategyId),
    rules: state.rules,
    thresholds: state.thresholds,
    onSelectStrategy: (id) => selectStrategy(id),
    onUpdateRule: (uid, patch) => {
      state.activeStrategyId = "custom_unsaved";
      state.activeStrategyName = "Unsaved Custom Draft";
      state.rules = state.rules.map((r) => (r.uid === uid ? { ...r, ...patch } : r));
      state.sweep = null;
      renderComposer();
      runEvaluation();
    },
    onRemoveRule: (uid) => {
      state.activeStrategyId = "custom_unsaved";
      state.activeStrategyName = "Unsaved Custom Draft";
      state.rules = state.rules.filter((r) => r.uid !== uid);
      state.sweep = null;
      renderComposer();
      runEvaluation();
    },
    onUpdateThresholds: (next) => {
      state.thresholds = next;
      renderComposer();
      runEvaluation();
    },
    onOpenCatalog: () => {
      openIndicatorCatalogModal({
        activeKeys: state.rules.map((r) => r.key),
        liveSignals: state.liveIndicatorSignals,
        onAddIndicator: (key) => {
          state.activeStrategyId = "custom_unsaved";
          state.activeStrategyName = "Unsaved Custom Draft";
          state.rules = [...state.rules, createRuleFromCatalog(key)];
          state.sweep = null;
          renderComposer();
          runEvaluation();
          toast(`Added ${key.toUpperCase()} to strategy`);
        },
      });
    },
    onSaveAsNew: () => {
      openCreatorStudio({
        name: state.activeStrategyName.replace(" (Copy)", ""),
        family: "custom",
        description: "Saved from Terminal Strategy Composer.",
        isCustom: false,
        thresholds: state.thresholds,
        rules: state.rules,
      });
    },
    onOpenArena: () => switchView("arena"),
  };

  renderStrategyBuilder($("strategyBuilderContainer"), { ...commonProps, visible: state.railTab === "edit" });
  renderStrategyBuilder($("simBuilderContainer"), { ...commonProps, visible: state.sim.railTab === "edit" });
}

function renderSimComposer() {
  renderComposer();
}

function renderActiveView() {
  document.querySelectorAll(".view-pane").forEach((p) => p.classList.remove("active"));
  $(`view-${state.view}`)?.classList.add("active");
  document.querySelectorAll(".nav-tab, .mob-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  syncUrlHash();

  if (state.view === "terminal") {
    requestAnimationFrame(() => chart.render());
  } else if (state.view === "arena") {
    renderStrategyArenaView($("strategyArenaContainer"), {
      symbol: state.symbol,
      tournament: state.tournament,
      benchmarks: state.benchmarks,
      expandedBenchmarkIds: state.expandedBenchmarkIds,
      benchFilterSym: state.benchFilterSym,
      benchSort: state.benchSort,
      activeStrategyId: state.activeStrategyId,
      pinnedIds: state.pinnedIds,
      arenaFilter: state.arenaFilter,
      arenaSort: state.arenaSort,
      arenaSearch: state.arenaSearch,
      onFilterChange: (fam) => { state.arenaFilter = fam; renderActiveView(); },
      onSortChange: (sort) => { state.arenaSort = sort; renderActiveView(); },
      onSearchChange: (q) => {
        state.arenaSearch = q;
        renderActiveView();
        const inp = $("arenaSearchInput");
        if (inp) { inp.focus(); inp.setSelectionRange(q.length, q.length); }
      },
      onToggleBenchmarkExpand: (stratId) => {
        if (state.expandedBenchmarkIds.has(stratId)) state.expandedBenchmarkIds.delete(stratId);
        else state.expandedBenchmarkIds.add(stratId);
        renderActiveView();
      },
      onBenchFilterSymChange: (val, stratId) => {
        state.benchFilterSym = val;
        renderActiveView();
        const inp = document.querySelector(`[data-bench-filter="${stratId}"]`);
        if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
      },
      onBenchSortChange: (sort) => { state.benchSort = sort; renderActiveView(); },
      onLaunchBenchmarkRun: (stratId, run, targetView) => launchBenchmarkRun(stratId, run, targetView),
      onSelectStrategy: (id, targetView) => {
        if (targetView) {
          selectStrategy(id);
          switchView(targetView);
        } else {
          selectStrategy(id);
        }
      },
      onTogglePin: togglePinStrategy,
      onOpenCreator: () => openCreatorStudio(),
      onCloneStrategy: (id) => {
        const src = allStrategies.find((s) => s.id === id);
        if (src) openCreatorStudio(src);
      },
      onDeleteCustomStrategy: deleteCustomStrategy,
      onExportStrategies: () => {
        const customs = loadCustomStrategies();
        const blob = new Blob([JSON.stringify(customs, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "risk-custom-strategies.json";
        a.click();
        toast(`Exported ${customs.length} custom strategy(ies)`);
      },
      onImportStrategies: () => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = ".json";
        inp.onchange = async () => {
          const file = inp.files?.[0];
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text());
            if (!Array.isArray(parsed)) throw new Error("Expected JSON array");
            saveCustomStrategies([...parsed, ...loadCustomStrategies()]);
            allStrategies = getAllStrategies();
            await runTournament();
            renderActiveView();
            toast(`Imported ${parsed.length} strategy(ies)`);
          } catch (e) { toast(`Import failed: ${e.message}`, "err"); }
        };
        inp.click();
      },
    });
  } else if (state.view === "backtest") {
    renderBacktestView($("backtestViewContainer"), {
      activeStrategyName: state.activeStrategyName,
      bars: state.bars,
      backtest: state.evalResult?.backtest,
      comparedCurves: getComparedStrategiesData(),
      sweep: state.sweep,
      monteCarlo: state.monteCarlo,
      backtestCfg: state.backtestCfg,
      onUpdateBacktestCfg: async (next) => {
        state.backtestCfg = next;
        state.sweep = null;
        state.monteCarlo = null;
        await runTournament();
        await runEvaluation();
      },
      onRunSweepAndMc: () => {
        runEvaluation({ runSweep: true, runMc: true }).then(() => toast("Completed 196-grid WASM sweep & 1,000x Monte Carlo"));
      },
      onApplyOptimalThresholds: (buy, sell) => {
        state.thresholds = {
          ...state.thresholds,
          buy,
          sell,
          strongBuy: Math.min(95, Math.max(buy + 22, 45)),
          strongSell: Math.max(-95, Math.min(sell - 22, -45)),
        };
        renderComposer();
        runEvaluation();
        toast(`Applied Buy ≥ ${buy} / Sell ≤ ${sell}`);
      },
      onSendToPaper: () => switchView("paper"),
    });
  } else if (state.view === "forecast") {
    const activeScore = state.evalResult?.score?.at(-1) ?? 0;
    renderForecastView($("forecastViewContainer"), {
      symbol: state.symbol,
      activeStrategyName: state.activeStrategyName,
      activeScore,
      thresholds: state.thresholds,
      bars: state.bars,
      forecast: state.evalResult?.forecast,
      forecastCfg: state.forecastCfg,
      onUpdateForecastCfg: (next) => { state.forecastCfg = next; runEvaluation(); },
      onSendToPaper: () => switchView("paper"),
    });
  } else if (state.view === "paper") {
    const currentPrice = state.bars.length ? state.bars[state.bars.length - 1].c : 0;
    const activeScore = state.evalResult?.score?.at(-1) ?? 0;
    renderPaperDeskView($("paperDeskViewContainer"), {
      symbol: state.symbol,
      currentPrice,
      activeStrategyName: state.activeStrategyName,
      activeScore,
      thresholds: state.thresholds,
      tournament: state.tournament,
      portfolio,
      replayState: state.replay,
      alpacaStatus: state.alpacaStatus,
      onSubmitOrder: async (ord) => {
        try {
          const t = await portfolio.submitMarketOrder(ord);
          if (t.brokerStatus === "rejected") toast(`Order rejected by Alpaca (no local fill): ${t.brokerError}`, "err");
          else if (t.brokerStatus === "unknown") toast(`Alpaca outcome unknown (${t.clientOrderId}) — reconcile before retrying`, "err");
          else if (t.brokerStatus.startsWith("alpaca:") && t.brokerStatus !== "alpaca:filled") toast(`Alpaca order ${t.brokerStatus} — reconcile to mirror fill`);
          else toast(`Filled ${t.side.toUpperCase()} ${t.qty} ${t.symbol} @ $${t.price.toFixed(2)}`);
          renderActiveView();
        } catch (e) { toast(e.message, "err"); }
      },
      onReconcileBroker: async () => {
        const res = await portfolio.reconcileBrokerOrders();
        if (res.errors.length) toast(`Reconcile error: ${res.errors[0]}`, "err");
        else toast(`Reconciled ${res.checked} broker order(s), ${res.filled} new fill(s)`);
        renderActiveView();
      },
      onPlacePending: (ord) => {
        portfolio.placePendingOrder(ord);
        toast(`Placed ${ord.type.toUpperCase()} ${ord.side.toUpperCase()} ${ord.qty} ${ord.symbol} @ $${ord.limitPrice.toFixed(2)}`);
        renderActiveView();
      },
      onCancelPending: (id) => { portfolio.cancelPendingOrder(id); renderActiveView(); },
      onFlattenPosition: async (sym) => {
        const pos = portfolio.state.positions[sym];
        if (!pos) return;
        const px = sym === state.symbol ? currentPrice : pos.lastPrice || pos.avgPrice;
        try {
          const t = await portfolio.submitMarketOrder({
            symbol: sym,
            side: pos.qty > 0 ? "sell" : "buy",
            qty: Math.abs(pos.qty),
            price: px,
            source: "flatten",
            bypassShortGuard: true,
          });
          if (t.brokerStatus === "rejected") toast(`Flatten rejected by Alpaca (position unchanged): ${t.brokerError}`, "err");
          else if (t.brokerStatus === "unknown") toast(`Flatten outcome unknown (${t.clientOrderId}) — reconcile before retrying`, "err");
          else if (t.brokerStatus.startsWith("alpaca:") && t.brokerStatus !== "alpaca:filled") toast(`Flatten submitted to Alpaca (${t.brokerStatus})`);
          else toast(`Flattened ${sym} position & cleared linked brackets`);
        } catch (e) { toast(e.message, "err"); }
        renderActiveView();
      },
      onResetPortfolio: () => { portfolio.reset(100000); toast("Paper account reset to $100,000"); renderActiveView(); },
      onToggleFlags: (partial) => { portfolio.setFlags(partial); renderActiveView(); },
      onReplayControl: (action, val) => handleReplayControl(action, val),
      onSaveSettings: () => { toast("Saved live data & proxy settings"); loadSymbol(state.symbol, { forceRefresh: true }); },
      onToggleLiveStream: () => {
        if (state.alpacaStatus === "live") { alpacaStream.disconnect(); toast("Disconnected Alpaca live stream"); }
        else {
          const cfg = loadDataSettings();
          if (!cfg.alpacaKey || !cfg.alpacaSecret) { toast("Enter your Alpaca API Key & Secret first", "err"); return; }
          alpacaStream.connect(state.symbol, cfg.alpacaKey, cfg.alpacaSecret, cfg.alpacaFeed || "iex");
          toast(`Connecting Alpaca IEX WebSocket for ${state.symbol}…`);
        }
      },
      onSelectTopStrategy: (id) => { selectStrategy(id, "paper"); toast(`Armed Paper Desk with ${state.activeStrategyName}`); },
      onOpenSimulator: () => switchView("simulator"),
    });
  } else if (state.view === "simulator") {
    renderSimDeckOnly();
    renderSimRailOnly();
    renderSimComposer();
    requestAnimationFrame(() => simChart.render());
  }
}

// ---- View Switching (Keeps Simulator Strictly Isolated from Live Data Tabs!) ----
async function switchView(nextView) {
  if (nextView === state.view) return;
  const wasSim = state.view === "simulator";
  if (wasSim) {
    stopSimPlayback();
  }
  state.livePollSeq++;
  $("toastRoot").innerHTML = "";
  state.view = nextView;
  renderActiveView();

  if (wasSim && nextView !== "simulator" && state.fullBars.length) {
    state.bars = state.fullBars;
    restoreLiveSourceBadge();
    updateQuoteStrip();
    await engine.loadBars(state.bars);
    await runTournament();
    await runEvaluation({ resetChartView: false });
  } else if (nextView === "simulator" && state.fullBars.length) {
    stopReplay(false);
    await ensureSimulatorInitialized({ resetView: true });
  }
}

// ---- Live Real-Time Chart Trade Popups, Position Overlay & Benchmark Launcher ----
function getLiveChartPositionOverlay(sym) {
  const pos = portfolio.state.positions[sym];
  let simPosition = null;
  if (pos && Math.abs(pos.qty) > 1e-8) {
    const resting = portfolio.state.pendingOrders.filter((o) => o.symbol === sym);
    const slOrd = resting.find((o) => o.type === "stop" && ((pos.qty > 0 && o.side === "sell") || (pos.qty < 0 && o.side === "buy")));
    const tpOrd = resting.find((o) => o.type === "limit" && ((pos.qty > 0 && o.side === "sell") || (pos.qty < 0 && o.side === "buy")));
    simPosition = {
      qty: pos.qty,
      avgPrice: pos.avgPrice,
      stopLossPrice: slOrd?.limitPrice ?? null,
      takeProfitPrice: tpOrd?.limitPrice ?? null,
    };
  }
  const simFills = [];
  if (state.bars.length) {
    const firstT = state.bars[0].t;
    for (const t of portfolio.state.trades) {
      if (t.symbol !== sym || t.applied === false || t.time < firstT - 86400_000) continue;
      // Map fill timestamp to nearest visible bar
      let bestIdx = state.bars.length - 1;
      let bestDist = Infinity;
      for (let i = state.bars.length - 1; i >= 0; i--) {
        const d = Math.abs(state.bars[i].t - t.time);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      simFills.push({ barIdx: bestIdx, side: t.side, price: t.price, qty: t.qty });
      if (simFills.length >= 12) break;
    }
  }
  return { simPosition, simFills };
}

function updateLiveChartPopup() {
  const host = $("chartSignalPopup");
  if (!host) return;
  if (state.view !== "terminal" || !state.bars.length || !state.evalResult?.score?.length) {
    renderLiveTradePopup(host, { rec: null, visible: false });
    return;
  }

  const markPx = state.bars[state.bars.length - 1].c;
  const rawPos = portfolio.state.positions[state.symbol];
  const openPosInfo = rawPos && Math.abs(rawPos.qty) > 1e-8
    ? { ...rawPos, unrealizedPnl: portfolio.getPositionUnrealizedPnl(rawPos, markPx) }
    : null;

  const rec = state.livePopupEnabled
    ? computeLiveTradeRecommendation({
        symbol: state.symbol,
        bars: state.bars,
        score: state.evalResult.score,
        thresholds: state.thresholds,
        rules: state.rules,
        ruleResults: state.evalResult.ruleResults || [],
        tournament: state.tournament,
        forecast: state.evalResult.forecast || null,
        portfolio,
        riskPct: state.livePopupRiskPct,
        allowShort: portfolio.state.allowShort || state.backtestCfg.allowShort,
        activeStrategyName: state.activeStrategyName,
        isEnsembleMode: isEnsembleStrategy(state.activeStrategyId),
      })
    : null;

  const showRec = !!(rec && !state.declinedSignals.has(rec.signalKey));

  renderLiveTradePopup(host, {
    rec: showRec ? rec : null,
    openPosition: openPosInfo,
    markPrice: markPx,
    visible: showRec,
    minimized: state.livePopupMinimized,
    riskPct: state.livePopupRiskPct,
    onChangeRiskPct: (rp) => { state.livePopupRiskPct = rp; updateLiveChartPopup(); },
    onToggleMinimize: (min) => { state.livePopupMinimized = min; updateLiveChartPopup(); },
    onEnableShorting: () => {
      portfolio.setFlags({ allowShort: true });
      state.backtestCfg.allowShort = true;
      toast("Shorting enabled on Paper Desk");
      updateLiveChartPopup();
    },
    onFlattenOpenPosition: async () => {
      const pos = portfolio.state.positions[state.symbol];
      if (!pos) return;
      try {
        const t = await portfolio.submitMarketOrder({
          symbol: state.symbol,
          side: pos.qty > 0 ? "sell" : "buy",
          qty: Math.abs(pos.qty),
          price: markPx,
          source: "chart:flatten",
          bypassShortGuard: true,
        });
        if (t.brokerStatus === "rejected") toast(`Flatten rejected by Alpaca: ${t.brokerError}`, "err");
        else if (t.brokerStatus === "unknown") toast(`Flatten outcome unknown (${t.clientOrderId}) — reconcile in Paper Desk`, "err");
        else toast(`Closed ${state.symbol} position @ $${t.price.toFixed(2)}`);
        const ov = getLiveChartPositionOverlay(state.symbol);
        chart.setData({ simPosition: ov.simPosition, simFills: ov.simFills });
        updateLiveChartPopup();
      } catch (e) { toast(e.message, "err"); }
    },
    onDecline: (r) => {
      state.declinedSignals.add(r.signalKey);
      updateLiveChartPopup();
      toast(`Declined ${r.rating.short} signal on ${r.symbol}`);
    },
    onAccept: async (r) => {
      try {
        if (r.action === "flatten") {
          const pos = portfolio.state.positions[r.symbol];
          if (!pos) return;
          const t = await portfolio.submitMarketOrder({
            symbol: r.symbol,
            side: pos.qty > 0 ? "sell" : "buy",
            qty: Math.abs(pos.qty),
            price: r.entryPx,
            source: "popup:exit",
            bypassShortGuard: true,
          });
          if (t.brokerStatus === "rejected") { toast(`Rejected by Alpaca: ${t.brokerError}`, "err"); return; }
          if (t.brokerStatus === "unknown") { toast(`Alpaca outcome unknown (${t.clientOrderId}) — reconcile in Paper Desk`, "err"); return; }
          toast(t.applied === false ? `Exit submitted to Alpaca (${t.brokerStatus})` : `Closed ${r.symbol} position @ $${t.price.toFixed(2)}`);
        } else {
          const side = r.action === "buy" ? "buy" : "sell";
          const t = await portfolio.submitMarketOrder({
            symbol: r.symbol,
            side,
            qty: r.shares,
            price: r.entryPx,
            source: `popup:${r.rating.short.toLowerCase().replace(/\s+/g, "_")}`,
            stopLoss: r.stopLoss,
            takeProfit: r.takeProfit,
            eligibleAfterBarTime: r.barTime,
          });
          if (t.brokerStatus === "rejected") { toast(`Order rejected by Alpaca: ${t.brokerError}`, "err"); return; }
          if (t.brokerStatus === "unknown") { toast(`Alpaca outcome unknown (${t.clientOrderId}) — reconcile in Paper Desk`, "err"); return; }
          if (t.applied === false) {
            toast(`Submitted broker-native bracket to Alpaca (${t.brokerStatus}) — awaiting fill`);
          } else {
            toast(`Executed ${side.toUpperCase()} ${r.shares} ${r.symbol} @ $${t.price.toFixed(2)} (OCO SL $${r.stopLoss} / TP $${r.takeProfit})`);
          }
        }
        state.declinedSignals.add(r.signalKey);
        const ov = getLiveChartPositionOverlay(state.symbol);
        chart.setData({ simPosition: ov.simPosition, simFills: ov.simFills });
        updateLiveChartPopup();
      } catch (e) {
        toast(e.message, "err");
      }
    },
  });
}

function setLivePollInterval(ms) {
  if (state.livePollTimer) { clearInterval(state.livePollTimer); state.livePollTimer = null; }
  state.livePollMs = ms;
  if (ms > 0) {
    state.livePollTimer = setInterval(async () => {
      if (state.view !== "terminal" || state.replay.active || state.livePollBusy) return;
      state.livePollBusy = true;
      const snap = { sym: state.symbol, range: state.range, interval: state.interval, seq: state.livePollSeq };
      try {
        const data = await fetchMarketData(snap.sym, snap.range, snap.interval, { forceRefresh: true });
        // Discard stale or out-of-order response if user switched symbol/timeframe/view mid-flight!
        if (
          snap.seq !== state.livePollSeq ||
          state.view !== "terminal" ||
          state.symbol !== snap.sym ||
          state.range !== snap.range ||
          state.interval !== snap.interval ||
          !data?.bars?.length
        ) {
          return;
        }
        state.marketMeta = data;
        state.fullBars = data.bars;
        state.bars = data.bars;
        await portfolio.processBar(snap.sym, data.bars[data.bars.length - 1], { isLiveTick: true });
        updateQuoteStrip();
        await engine.loadBars(state.bars);
        await runTournament();
        await runEvaluation();
      } catch {
        /* ignore transient poll errors */
      } finally {
        state.livePollBusy = false;
      }
    }, ms);
    toast(`Live auto-poll active (every ${ms / 1000}s)`);
  }
}

async function launchBenchmarkRun(stratId, run, targetView = "terminal") {
  // 1. Restore ALL exact benchmark settings (capital, size, fees, slippage, thresholds, SL/TP, shorting)
  const found = allStrategies.find((s) => s.id === stratId);
  if (found) {
    state.activeStrategyId = found.id;
    state.activeStrategyName = found.name;
    state.rules = found.rules.map((x) => ({ ...x, params: { ...x.params } }));
  }
  state.thresholds = {
    strongBuy: run.settings.strongBuy,
    buy: run.settings.buyThresh,
    sell: run.settings.sellThresh,
    strongSell: run.settings.strongSell,
  };
  state.backtestCfg = {
    ...state.backtestCfg,
    initialCapital: run.settings.initialCapital ?? 100000,
    positionPct: run.settings.positionPct ?? 100,
    commissionBps: run.settings.commissionBps ?? 1,
    slippageBps: run.settings.slippageBps ?? 2,
    allowShort: !!run.settings.allowShort,
    stopLossPct: Number(run.settings.stopLossPct || 0),
    takeProfitPct: Number(run.settings.takeProfitPct || 0),
  };
  portfolio.setFlags({ allowShort: !!run.settings.allowShort });

  if (targetView === "simulator") {
    sim.allowShort = !!run.settings.allowShort;
    sim.feeBps = run.settings.commissionBps ?? 1;
    sim.slippageBps = run.settings.slippageBps ?? 2;
    sim.shadowStopLossPct = Number(run.settings.stopLossPct || 0);
    sim.shadowTakeProfitPct = Number(run.settings.takeProfitPct || 0);
    state.sim.stopLossPct = Number(run.settings.stopLossPct || 0);
    state.sim.takeProfitPct = Number(run.settings.takeProfitPct || 0);
    state.sim.pendingBenchmarkWindow = {
      startTime: run.startTime || null,
      endTime: run.endTime || null,
      oosSplitTime: run.oosSplitTime || null,
      oosSplitIdx: run.oosSplitIdx || null,
      initialCapital: run.settings.initialCapital ?? 100000,
    };
  }

  // 2. Apply exact benchmark timeframe & range in global top-right toolbar
  state.interval = run.interval;
  state.range = run.range;
  $("intervalGroup").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.interval === run.interval));
  $("rangeGroup").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.range === run.range));

  // 3. Switch view and load benchmark symbol
  stopSimPlayback();
  state.livePollSeq++;
  state.view = targetView;
  renderActiveView();
  renderComposer();
  await loadSymbol(run.symbol);
  if (targetView !== "simulator" || state.sim.lastBenchmarkExactMatch !== false) {
    toast(`Launched ${run.symbol} ${run.interval}/${run.range} · ${run.profileLabel} in ${targetView === "simulator" ? "Simulator (exact saved OOS window)" : "Chart"}`);
  }
}

async function runLiveUniverseScan(onItem) {
  const syms = BENCHMARK_TICKERS;
  const savedBars = state.bars;
  const savedRules = state.rules;
  const savedTh = state.thresholds;
  for (const sym of syms) {
    try {
      const data = await fetchMarketData(sym, "3mo", "1d");
      if (!data?.bars?.length) continue;
      await engine.loadBars(data.bars);
      const res = await engine.evaluate({
        rules: savedRules,
        backtestCfg: { ...state.backtestCfg, buyThresh: savedTh.buy, sellThresh: savedTh.sell, barsPerYear: 252 },
        forecastCfg: state.forecastCfg,
        runSweep: false,
        runMc: false,
      });
      const last = data.bars[data.bars.length - 1];
      const prev = data.bars[data.bars.length - 2] || last;
      const sc = res.score?.[res.score.length - 1] ?? 0;
      const r = classifyScore(sc, savedTh);
      onItem(sym, {
        price: last.c,
        chgPct: prev.c > 0 ? ((last.c - prev.c) / prev.c) * 100 : 0,
        score: sc,
        short: r.short,
      });
    } catch { /* skip */ }
  }
  // Restore active ticker bars into WASM worker
  if (savedBars.length) {
    await engine.loadBars(savedBars);
    await runTournament();
    await runEvaluation();
  }
}

// ---- Interactive Live-Chart Paper Trading Simulator Engine ----
function getSimMinCursor(total) {
  return Math.min(total, Math.max(45, Math.min(70, Math.floor(total * 0.25))));
}

function stopSimPlayback() {
  if (state.sim.timer) { clearInterval(state.sim.timer); state.sim.timer = null; }
  state.sim.playing = false;
  state.sim.fastForwarding = false;
}

async function setSimRegion({ startCursor, endCursor, cursor, resetWallet = true, resetView = true, startingCash = null } = {}) {
  stopSimPlayback();
  const total = state.fullBars.length;
  if (!total) return;
  const minC = getSimMinCursor(total);
  const s = Math.min(total, Math.max(minC, Math.floor(startCursor ?? minC)));
  const e = Math.min(total, Math.max(s, Math.floor(endCursor ?? total)));
  const cur = Math.min(e, Math.max(s, Math.floor(cursor ?? s)));
  state.sim.startCursor = s;
  state.sim.endCursor = e;
  state.sim.cursor = cur;
  state.sim.seriesKey = `${state.symbol}:${state.interval}:${state.range}:${total}`;
  state.sim.activePrompt = null;
  state.sim.hoverIdx = -1;
  if (resetWallet) {
    const cap = Number.isFinite(startingCash) && startingCash > 0 ? startingCash : (state.backtestCfg.initialCapital || sim.startingCash || 100000);
    sim.reset(cap, cur, state.fullBars[cur - 1].c);
  }
  await syncSimulatorBar({ evaluatePrompt: resetWallet, resetView, followRight: true });
}

async function ensureSimulatorInitialized({ resetView = true } = {}) {
  const total = state.fullBars.length;
  if (!total) return;
  const key = `${state.symbol}:${state.interval}:${state.range}:${total}`;
  const minC = getSimMinCursor(total);
  const bw = state.sim.pendingBenchmarkWindow;
  if (bw) {
    state.sim.pendingBenchmarkWindow = null;
    // Check for exact saved benchmark OOS boundary & end timestamps; disclose honestly if rolling feed moved!
    const exactStartIdx = bw.oosSplitTime ? state.fullBars.findIndex((b) => b.t === bw.oosSplitTime) : -1;
    const exactEndIdx = bw.endTime ? state.fullBars.findIndex((b) => b.t === bw.endTime) : -1;
    const exactMatch = exactStartIdx >= 0 && exactEndIdx >= exactStartIdx;
    state.sim.lastBenchmarkExactMatch = exactMatch;

    let startC = exactMatch ? Math.max(minC, exactStartIdx + 1) : Math.max(minC, Math.floor(total * 0.7));
    let endC = exactMatch ? exactEndIdx + 1 : total;
    await setSimRegion({ startCursor: startC, endCursor: endC, cursor: startC, resetWallet: true, resetView, startingCash: bw.initialCapital });
    if (!exactMatch) {
      toast("Saved benchmark dates shifted out of rolling feed — loaded closest 70% OOS window instead", "err");
    }
  } else if (state.sim.seriesKey !== key || state.sim.cursor < minC || state.sim.cursor > total) {
    const defaultStart = Math.max(minC, Math.floor(total * 0.6));
    await setSimRegion({ startCursor: defaultStart, endCursor: total, cursor: defaultStart, resetWallet: true, resetView });
  } else {
    await syncSimulatorBar({ evaluatePrompt: false, resetView, followRight: true });
  }
}

async function syncSimulatorBar({ evaluatePrompt = true, resetView = false, followRight = true } = {}) {
  if (!state.fullBars.length) return;
  const total = state.fullBars.length;
  const endC = Math.min(total, Math.max(1, state.sim.endCursor || total));
  const cursor = Math.min(endC, Math.max(1, state.sim.cursor));
  state.bars = state.fullBars.slice(0, cursor);
  updateSourceBadge(`SIM · ${cursor}/${endC}`, true);
  updateQuoteStrip();

  await engine.loadBars(state.bars);
  await runTournament();
  await runEvaluation({ resetChartView: resetView });

  if (evaluatePrompt && state.evalResult?.score?.length) {
    const barIdx = cursor - 1;
    const sc = state.evalResult.score[barIdx] ?? 0;
    const prompt = sim.evaluateBarSignal({
      barIdx,
      bar: state.bars[barIdx],
      score: sc,
      thresholds: state.thresholds,
      tournamentStrategies: state.tournament?.strategies || [],
      ruleResults: state.evalResult.ruleResults || [],
      rules: state.rules,
    });
    if (prompt) {
      state.sim.activePrompt = prompt;
      stopSimPlayback();
      toast(`⏸ Co-Pilot paused: ${prompt.headline}`);
    }
  }

  simChart.setData({
    bars: state.bars,
    interval: state.interval,
    activeStrategyId: state.activeStrategyId,
    activeStrategyName: state.activeStrategyName,
    rules: isEnsembleStrategy(state.activeStrategyId) ? [] : state.rules,
    ruleResults: state.evalResult?.ruleResults || [],
    score: state.evalResult?.score || [],
    trades: state.evalResult?.backtest?.trades || [],
    forecast: state.evalResult?.forecast || null,
    consensus: state.tournament?.consensus || null,
    tournamentStrategies: state.tournament?.strategies || [],
    comparedStrategies: getComparedStrategiesData(),
    simFills: sim.fills,
    simPosition: sim.position,
    thresholds: state.thresholds,
    resetView,
    followRight,
  });

  renderSimDeckOnly();
  renderSimRailOnly();
}

async function advanceSimBars(count = 1) {
  if (state.view !== "simulator" || state.sim.busy || !state.fullBars.length) return;
  state.sim.busy = true;
  state.sim.activePrompt = null;
  const endCap = Math.min(state.fullBars.length, state.sim.endCursor || state.fullBars.length);
  try {
    for (let step = 0; step < count; step++) {
      if (state.sim.cursor >= endCap) {
        stopSimPlayback();
        const st = sim.getStats(state.fullBars[state.sim.cursor - 1]?.c);
        toast(`Region complete · You ${st.totalReturnPct >= 0 ? "+" : ""}${st.totalReturnPct.toFixed(2)}% vs Strategy ${st.shadowReturnPct >= 0 ? "+" : ""}${st.shadowReturnPct.toFixed(2)}%`);
        renderSimDeckOnly();
        break;
      }
      state.sim.cursor++;
      const barIdx = state.sim.cursor - 1;
      const newBar = state.fullBars[barIdx];
      const events = sim.processNewBarOpenAndBrackets(newBar, barIdx);
      let bracketTriggered = false;
      for (const ev of events) {
        if (ev.type === "stop_loss" || ev.type === "take_profit") {
          bracketTriggered = true;
          stopSimPlayback();
          toast(`${ev.type === "stop_loss" ? "🛑 STOP LOSS" : "🎯 TAKE PROFIT"} filled @ $${ev.fill.price.toFixed(2)}`, ev.type === "stop_loss" ? "err" : "ok");
        } else if (ev.type === "queued_fill") {
          toast(`Next-Open filled ${ev.fill.side.toUpperCase()} ${ev.fill.qty.toFixed(2)} @ $${ev.fill.price.toFixed(2)}`);
        } else if (ev.type === "queued_error") {
          toast(ev.message, "err");
        }
      }

      await syncSimulatorBar({ evaluatePrompt: true, resetView: false, followRight: true });
      if (state.sim.activePrompt || bracketTriggered) break;
    }
  } finally {
    state.sim.busy = false;
    renderSimDeckOnly();
  }
}

function toggleSimPlayback() {
  if (state.sim.playing || state.sim.fastForwarding) {
    stopSimPlayback();
    renderSimDeckOnly();
    return;
  }
  const endCap = Math.min(state.fullBars.length, state.sim.endCursor || state.fullBars.length);
  if (state.sim.cursor >= endCap) {
    toast("Already at region end — adjust Start/End or click Random to restart", "err");
    return;
  }
  state.sim.activePrompt = null;
  state.sim.playing = true;
  renderSimDeckOnly();
  advanceSimBars(1);
  state.sim.timer = setInterval(() => {
    if (state.sim.playing && !state.sim.busy) advanceSimBars(1);
  }, state.sim.speedMs);
}

async function fastForwardToNextPrompt() {
  if (state.sim.fastForwarding) {
    stopSimPlayback();
    renderSimDeckOnly();
    return;
  }
  if (sim.pauseMode === "manual") {
    toast("Select a Co-Pilot Pause Mode (not Manual Only) to jump to next prompt", "err");
    return;
  }
  stopSimPlayback();
  state.sim.activePrompt = null;
  state.sim.playing = true;
  state.sim.fastForwarding = true;
  renderSimDeckOnly();

  const endCap = Math.min(state.fullBars.length, state.sim.endCursor || state.fullBars.length);
  while (state.sim.fastForwarding && state.view === "simulator" && state.sim.cursor < endCap) {
    await advanceSimBars(1);
    if (state.sim.activePrompt || !state.sim.playing) break;
    await new Promise((r) => setTimeout(r, 12));
  }
  stopSimPlayback();
  renderSimDeckOnly();
}

function handleSimUserTrade(side, reason = "manual") {
  if (!state.bars.length) return;
  const barIdx = state.bars.length - 1;
  const bar = state.bars[barIdx];
  try {
    const res = sim.submitUserAction({
      side,
      pct: state.sim.sizePct,
      price: bar.c,
      barIdx,
      time: bar.t,
      reason,
      stopLossPct: state.sim.stopLossPct,
      takeProfitPct: state.sim.takeProfitPct,
    });
    if (!res) { toast("No open position to flatten", "err"); return; }
    if (res.queued) {
      toast(`Queued ${res.order.side.toUpperCase()} ${res.order.shares.toFixed(2)} @ Next Bar Open`);
    } else {
      toast(`SIM ${res.side.toUpperCase()} ${res.qty.toFixed(2)} ${state.symbol} @ $${res.price.toFixed(2)}`);
    }
    state.sim.activePrompt = null;
    simChart.setData({ simFills: sim.fills, simPosition: sim.position });
    renderSimRailOnly();
  } catch (e) {
    toast(e.message, "err");
  }
}

function renderSimDeckOnly() {
  renderSimulatorDeck($("simDeckContainer"), {
    sim,
    simState: state.sim,
    fullBars: state.fullBars,
    interval: state.interval,
    range: state.range,
    onPlayToggle: toggleSimPlayback,
    onStep: (n) => { stopSimPlayback(); advanceSimBars(n); },
    onNextPrompt: fastForwardToNextPrompt,
    onSpeedChange: (ms) => {
      state.sim.speedMs = ms;
      if (state.sim.playing && !state.sim.fastForwarding) {
        clearInterval(state.sim.timer);
        state.sim.timer = setInterval(() => { if (state.sim.playing && !state.sim.busy) advanceSimBars(1); }, state.sim.speedMs);
      }
    },
    onSetRegion: ({ startCursor, endCursor, cursor, resetWallet }) => {
      setSimRegion({ startCursor, endCursor, cursor, resetWallet, resetView: resetWallet }).then(() =>
        toast(`Replay region: Bars ${startCursor} → ${endCursor} (${endCursor - startCursor} bars)`)
      );
    },
    onRandomStart: () => {
      const total = state.fullBars.length;
      const minC = getSimMinCursor(total);
      const span = Math.min(Math.max(30, Math.floor((total - minC) * 0.5)), total - minC);
      const maxStart = Math.max(minC, total - span);
      const randStart = minC + Math.floor(Math.random() * Math.max(1, maxStart - minC + 1));
      const randEnd = Math.min(total, randStart + span);
      setSimRegion({ startCursor: randStart, endCursor: randEnd, cursor: randStart, resetWallet: true, resetView: true }).then(() =>
        toast(`Blind session: Bars ${randStart} → ${randEnd} (${randEnd - randStart} bars)`)
      );
    },
    onResetSim: () => {
      const s = state.sim.startCursor || getSimMinCursor(state.fullBars.length);
      const e = state.sim.endCursor || state.fullBars.length;
      setSimRegion({ startCursor: s, endCursor: e, cursor: s, resetWallet: true, resetView: false }).then(() =>
        toast("Simulator wallet reset to $100,000")
      );
    },
    onPauseModeChange: (mode) => {
      sim.pauseMode = mode;
      renderSimDeckOnly();
    },
    onFillModeChange: (mode) => {
      sim.fillMode = mode;
      renderSimDeckOnly();
      renderSimRailOnly();
    },
  });
}

function renderSimRailOnly({ hoverOnly = false } = {}) {
  renderSimulatorRail($("simRailContainer"), {
    hoverOnly,
    symbol: state.symbol,
    interval: state.interval,
    activeStrategyName: state.activeStrategyName,
    isEnsembleMode: isEnsembleStrategy(state.activeStrategyId),
    sim,
    simState: state.sim,
    bars: state.bars,
    activeIdx: state.sim.hoverIdx,
    rules: state.rules,
    ruleResults: state.evalResult?.ruleResults || [],
    score: state.evalResult?.score || [],
    thresholds: state.thresholds,
    forecast: state.evalResult?.forecast || null,
    tournament: state.tournament,
    onUserTrade: (side) => handleSimUserTrade(side, "manual"),
    onCancelPending: () => { sim.pendingOrder = null; renderSimRailOnly(); toast("Cancelled pending Next-Open order"); },
    onPromptAccept: () => {
      const p = state.sim.activePrompt;
      if (!p) return;
      sim.recordDecision({ barIdx: p.barIdx, time: p.time, action: p.kind, promptReason: p.headline, stratLabel: p.rating.label, price: p.price });
      if (p.kind === "buy") {
        handleSimUserTrade("buy", "co-pilot accept");
      } else if (sim.position && sim.position.qty > 0) {
        handleSimUserTrade("flatten", "co-pilot exit");
      } else if (sim.allowShort) {
        handleSimUserTrade("sell", "co-pilot short");
      } else {
        state.sim.activePrompt = null;
        renderSimRailOnly();
        toast("Accepted Co-Pilot signal (already flat)");
      }
    },
    onPromptSkip: () => {
      const p = state.sim.activePrompt;
      if (p) {
        sim.recordDecision({ barIdx: p.barIdx, time: p.time, action: "skip", promptReason: p.headline, stratLabel: p.rating.label, price: p.price });
      }
      state.sim.activePrompt = null;
      renderSimRailOnly();
      toggleSimPlayback();
    },
    onPromptDismiss: () => {
      state.sim.activePrompt = null;
      renderSimRailOnly();
    },
    onChangeSizePct: (pct) => { state.sim.sizePct = pct; renderSimRailOnly(); },
    onUpdateBracket: (patch) => { Object.assign(state.sim, patch); },
    onToggleAllowShort: (val) => { sim.allowShort = val; renderSimRailOnly(); },
    onChangeRailTab: (tab) => {
      state.sim.railTab = tab;
      renderSimRailOnly();
      renderSimComposer();
    },
    onSwitchStrategy: (id) => selectStrategy(id),
  });
}

// ---- Market Data Loading ----
async function loadSymbol(symbol, { forceRefresh = false } = {}) {
  stopReplay(false);
  state.livePollSeq++;
  const sym = symbol.trim().toUpperCase();
  if (!sym) return;
  state.symbol = sym;
  tickerInput.value = sym;
  updateQuickTickerActive();
  updateSourceBadge("FETCHING…", false);
  syncUrlHash();

  const data = await fetchMarketData(sym, state.range, state.interval, { forceRefresh });
  state.marketMeta = data;
  state.fullBars = data.bars;
  state.bars = data.bars;
  state.sweep = null;
  state.monteCarlo = null;
  state.hoverIdx = -1;

  restoreLiveSourceBadge();
  if (data.warning) toast(data.warning, "err");

  updateQuoteStrip();
  if (state.view === "simulator") {
    state.sim.seriesKey = "";
    await ensureSimulatorInitialized({ resetView: true });
    await refreshIndicatorSnapshot();
  } else {
    await engine.loadBars(state.bars);
    await Promise.all([runTournament(), refreshIndicatorSnapshot()]);
    await runEvaluation({ resetChartView: true });
  }
}

async function handleLiveTick({ price, size, time }) {
  if (!state.bars.length || state.replay.active) return;
  const last = state.bars[state.bars.length - 1];
  last.c = price;
  if (price > last.h) last.h = price;
  if (price < last.l) last.l = price;
  last.v += size || 0;
  last.t = time;
  await portfolio.processBar(state.symbol, last, { isLiveTick: true });
  updateQuoteStrip();
  await engine.loadBars(state.bars);
  await runEvaluation();
}

// ---- Serialized, Strictly Causal, Next-Bar-Open Market Replay Engine ----
function stopReplay(restoreFull = true) {
  if (state.replay.timer) { clearInterval(state.replay.timer); state.replay.timer = null; }
  state.replay.playing = false;
  state.replay.pendingAutoOrder = null;
  if (restoreFull && state.replay.active) {
    state.replay.active = false;
    state.bars = state.fullBars;
    restoreLiveSourceBadge();
    engine.loadBars(state.bars).then(async () => {
      await runTournament();
      await runEvaluation({ resetChartView: true });
    });
    updateQuoteStrip();
  }
}

async function advanceReplayBar() {
  if (!state.replay.active || state.replay.busy) return;
  if (state.replay.cursor > state.fullBars.length) {
    state.replay.playing = false;
    clearInterval(state.replay.timer);
    state.replay.timer = null;
    toast("Market Replay reached latest bar");
    if (state.view === "paper") renderActiveView();
    return;
  }

  state.replay.busy = true;
  try {
    state.bars = state.fullBars.slice(0, state.replay.cursor);
    const currentBar = state.bars[state.bars.length - 1];

    // 1. Execute any queued Auto-Trade signal from the PREVIOUS bar at THIS bar's OPEN (matching backtester!)
    if (state.replay.pendingAutoOrder && portfolio.state.autoTrade) {
      const ord = state.replay.pendingAutoOrder;
      state.replay.pendingAutoOrder = null;
      const pos = portfolio.state.positions[state.symbol];
      const fillOpen = currentBar.o;
      if (ord.side === "buy" && (!pos || pos.qty <= 0)) {
        const shares = Math.max(1, Math.round((portfolio.state.cash * 0.25) / Math.max(1, fillOpen)));
        const qty = pos ? Math.abs(pos.qty) + shares : shares;
        await portfolio.submitMarketOrder({ symbol: state.symbol, side: "buy", qty, price: fillOpen, source: `auto:${ord.stratName.slice(0, 11)}` });
      } else if (ord.side === "sell" && pos && pos.qty > 0) {
        await portfolio.submitMarketOrder({ symbol: state.symbol, side: "sell", qty: pos.qty, price: fillOpen, source: `auto:${ord.stratName.slice(0, 11)}` });
      }
    }

    // 2. Process resting limit/stop orders against this bar's H/L
    await portfolio.processBar(state.symbol, currentBar);
    updateQuoteStrip();

    // 3. Always recompute causal tournament & evaluation on ONLY bars[0..cursor-1] so NO future consensus ever leaks!
    await engine.loadBars(state.bars);
    await runTournament();
    await runEvaluation();

    // 4. Queue new auto-trade signal at bar Close for NEXT bar's Open
    if (portfolio.state.autoTrade && state.evalResult?.score?.length) {
      const sc = state.evalResult.score[state.evalResult.score.length - 1];
      const rating = classifyScore(sc, state.thresholds);
      const pos = portfolio.state.positions[state.symbol];
      if ((rating.id === "strong_buy" || rating.id === "buy") && (!pos || pos.qty <= 0)) {
        state.replay.pendingAutoOrder = { side: "buy", stratName: state.activeStrategyName };
      } else if ((rating.id === "strong_sell" || rating.id === "sell") && pos && pos.qty > 0) {
        state.replay.pendingAutoOrder = { side: "sell", stratName: state.activeStrategyName };
      }
    }

    state.replay.cursor++;
    if (state.view === "paper") renderActiveView();
  } finally {
    state.replay.busy = false;
  }
}

function handleReplayControl(action, val) {
  if (action === "speed") {
    state.replay.speedMs = val;
    if (state.replay.playing) {
      clearInterval(state.replay.timer);
      state.replay.timer = setInterval(advanceReplayBar, state.replay.speedMs);
    }
    return;
  }
  if (action === "exit") { stopReplay(true); toast("Exited Market Replay"); renderActiveView(); return; }
  if (!state.replay.active) {
    if (state.fullBars.length < 85) { toast("Need at least 85 bars to start replay", "err"); return; }
    state.replay.active = true;
    state.replay.total = state.fullBars.length;
    state.replay.cursor = Math.max(70, Math.floor(state.fullBars.length * 0.65));
    state.replay.pendingAutoOrder = null;
    updateSourceBadge("CAUSAL REPLAY", true);
  }
  if (action === "step") { advanceReplayBar(); return; }
  if (action === "toggle") {
    if (state.replay.playing) {
      state.replay.playing = false;
      clearInterval(state.replay.timer);
      state.replay.timer = null;
    } else {
      state.replay.playing = true;
      advanceReplayBar();
      state.replay.timer = setInterval(advanceReplayBar, state.replay.speedMs);
    }
    renderActiveView();
  }
}

// ---- Wire Global Controls ----
function renderQuickTickers() {
  const root = $("quickTickers");
  root.innerHTML = POPULAR_TICKERS.slice(0, 6)
    .map((t) => `<button class="quick-ticker-btn ${t.symbol === state.symbol ? "active" : ""}" data-sym="${t.symbol}" title="${t.name}">${t.symbol}</button>`)
    .join("");
  root.querySelectorAll("[data-sym]").forEach((btn) => btn.addEventListener("click", () => loadSymbol(btn.dataset.sym)));
}

function updateQuickTickerActive() {
  document.querySelectorAll(".quick-ticker-btn").forEach((b) => b.classList.toggle("active", b.dataset.sym === state.symbol));
}

strategySwitcherBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (strategySwitcherPopover.classList.contains("hidden")) openSwitcherPopover();
  else closeSwitcherPopover();
});
document.addEventListener("click", (e) => {
  if (!strategySwitcherPopover.classList.contains("hidden") && !strategySwitcherPopover.contains(e.target) && !strategySwitcherBtn.contains(e.target)) {
    closeSwitcherPopover();
  }
});

$("prevStratBtn").addEventListener("click", () => stepRankedStrategy(-1));
$("nextStratBtn").addEventListener("click", () => stepRankedStrategy(1));
$("globalNewStratBtn").addEventListener("click", () => openCreatorStudio());
globalConsensusPill.addEventListener("click", () => switchView("arena"));
$("mobileConsensusBtn")?.addEventListener("click", () => switchView("arena"));
$("globalCompareBtn").addEventListener("click", () => {
  if (state.view === "simulator") {
    simSubPaneSelect.value = "compare";
    simChart.setOptions({ subPaneMode: "compare" });
    syncUrlHash();
    toast(`Overlaying Active + ${state.pinnedIds.length} pinned strategies in Simulator`);
    return;
  }
  switchView("terminal");
  subPaneSelect.value = "compare";
  chart.setOptions({ subPaneMode: "compare" });
  syncUrlHash();
  toast(`Overlaying Active + ${state.pinnedIds.length} pinned strategies`);
});

// Ticker Search Autocomplete
let searchTimer = null;
tickerInput.addEventListener("input", () => {
  const q = tickerInput.value.trim();
  clearTimeout(searchTimer);
  if (!q) { tickerDropdown.classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    const quotes = await searchSymbols(q);
    if (!quotes.length) { tickerDropdown.classList.add("hidden"); return; }
    tickerDropdown.innerHTML = quotes
      .map((item) => `
        <button class="ticker-option" data-pick-sym="${item.symbol}">
          <span class="ticker-opt-sym">${item.symbol}</span>
          <span class="ticker-opt-name">${item.name}</span>
          <span class="muted mono" style="font-size:10px">${item.exchange}</span>
        </button>`)
      .join("");
    tickerDropdown.classList.remove("hidden");
    tickerDropdown.querySelectorAll("[data-pick-sym]").forEach((b) => {
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        tickerDropdown.classList.add("hidden");
        loadSymbol(b.dataset.pickSym);
      });
    });
  }, 220);
});

tickerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { tickerDropdown.classList.add("hidden"); loadSymbol(tickerInput.value); tickerInput.blur(); }
  else if (e.key === "Escape") { tickerDropdown.classList.add("hidden"); tickerInput.value = state.symbol; tickerInput.blur(); }
});
tickerInput.addEventListener("blur", () => setTimeout(() => tickerDropdown.classList.add("hidden"), 150));

document.querySelectorAll(".nav-tab, .mob-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

$("intervalGroup").querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.interval = btn.dataset.interval;
    $("intervalGroup").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    loadSymbol(state.symbol);
  });
});

$("rangeGroup").querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.range = btn.dataset.range;
    $("rangeGroup").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    loadSymbol(state.symbol);
  });
});

$("openUniverseBtn")?.addEventListener("click", () => {
  openUniverseModal({
    activeSymbol: state.symbol,
    activeStrategyName: state.activeStrategyName,
    scanCache: state.scanCache,
    onSelectSymbol: (sym) => loadSymbol(sym),
    onRunLiveScan: runLiveUniverseScan,
  });
});
$("refreshDataBtn").addEventListener("click", () => loadSymbol(state.symbol, { forceRefresh: true }));

$("toggleLivePopupBtn")?.addEventListener("click", (e) => {
  state.livePopupEnabled = !state.livePopupEnabled;
  e.currentTarget.classList.toggle("active", state.livePopupEnabled);
  if (state.livePopupEnabled) state.declinedSignals.clear();
  updateLiveChartPopup();
});
$("livePollSelect")?.addEventListener("change", (e) => setLivePollInterval(Number(e.target.value || 0)));

$("chartStyleGroup").querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("chartStyleGroup").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    chart.setOptions({ chartStyle: btn.dataset.style });
  });
});
$("toggleForecastBtn").addEventListener("click", (e) => {
  const next = !chart.showForecast;
  e.currentTarget.classList.toggle("active", next);
  chart.setOptions({ showForecast: next });
});
$("toggleSignalsBtn").addEventListener("click", (e) => {
  const next = !chart.showSignals;
  e.currentTarget.classList.toggle("active", next);
  chart.setOptions({ showSignals: next });
});
$("toggleHaloBtn").addEventListener("click", (e) => {
  const next = !chart.showConsensusHalo;
  e.currentTarget.classList.toggle("active", next);
  chart.setOptions({ showConsensusHalo: next });
});

subPaneSelect.addEventListener("change", () => {
  chart.setOptions({ subPaneMode: subPaneSelect.value });
  syncUrlHash();
});
$("resetZoomBtn").addEventListener("click", () => chart.resetZoom());

// Simulator Chart Toolbar Controls
$("simChartStyleGroup")?.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("simChartStyleGroup").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    simChart.setOptions({ chartStyle: btn.dataset.style });
  });
});
$("simToggleForecastBtn")?.addEventListener("click", (e) => {
  const next = !simChart.showForecast;
  e.currentTarget.classList.toggle("active", next);
  simChart.setOptions({ showForecast: next });
});
$("simToggleSignalsBtn")?.addEventListener("click", (e) => {
  const next = !simChart.showSignals;
  e.currentTarget.classList.toggle("active", next);
  simChart.setOptions({ showSignals: next });
});
$("simToggleHaloBtn")?.addEventListener("click", (e) => {
  const next = !simChart.showConsensusHalo;
  e.currentTarget.classList.toggle("active", next);
  simChart.setOptions({ showConsensusHalo: next });
});
simSubPaneSelect?.addEventListener("change", () => {
  simChart.setOptions({ subPaneMode: simSubPaneSelect.value });
  syncUrlHash();
});
$("simResetZoomBtn")?.addEventListener("click", () => simChart.resetZoom());

// Global Keyboard Shortcuts (Escape closes modals/popovers, ⌘K opens switcher, [/] cycles strategies, Space/→ in Simulator, 1..6 views, / ticker)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.getElementById("indicatorCatalogModal")?.remove();
    document.getElementById("strategyCreatorModal")?.remove();
    document.getElementById("universeModal")?.remove();
    closeSwitcherPopover();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (strategySwitcherPopover.classList.contains("hidden")) openSwitcherPopover();
    else closeSwitcherPopover();
    return;
  }
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (state.view === "simulator") {
    if (e.key === " ") { e.preventDefault(); toggleSimPlayback(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); stopSimPlayback(); advanceSimBars(1); return; }
  }
  if (e.key === "/") { e.preventDefault(); tickerInput.focus(); tickerInput.select(); }
  else if (e.key === "[") stepRankedStrategy(-1);
  else if (e.key === "]") stepRankedStrategy(1);
  else if (e.key === "1") switchView("terminal");
  else if (e.key === "2") switchView("arena");
  else if (e.key === "3") switchView("backtest");
  else if (e.key === "4") switchView("forecast");
  else if (e.key === "5") switchView("simulator");
  else if (e.key === "6") switchView("paper");
});

// ---- Bootstrap ----
const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
document.querySelectorAll(".kbd-hint").forEach((el) => { el.textContent = isMacPlatform ? "⌘K" : "Ctrl K"; });
const uniBtn = $("openUniverseBtn");
if (uniBtn) uniBtn.textContent = `Markets (${MARKET_UNIVERSE.length})`;
renderQuickTickers();
syncGlobalStrategyBar();
renderComposer();
renderActiveView();
fetch("/src/data/benchmarks.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (data) {
      state.benchmarks = data;
      if (state.view === "arena") renderActiveView();
    }
  })
  .catch(() => {});
loadSymbol(state.symbol);
