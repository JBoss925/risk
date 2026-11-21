import { INDICATOR_BY_ID, INDICATOR_CATALOG, INDICATOR_CATEGORIES, createRuleFromCatalog } from "../data/indicators.js";
import { STRATEGY_FAMILIES, DEFAULT_THRESHOLDS, classifyScore } from "../data/strategies.js";
import { computeConsensusSummary, fmtFixed, fmtPct as fmtPctShared, plural } from "./format.js";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function fmtPct(v) {
  return fmtPctShared(v, 1, true);
}

function drawSparkline(canvas, pts, w = 92, h = 26) {
  if (!canvas || !pts?.length) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let min = Infinity; let max = -Infinity;
  for (const v of pts) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  const up = pts[pts.length - 1] >= pts[0];
  ctx.strokeStyle = up ? "#34d399" : "#fb7185";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = (i / Math.max(1, pts.length - 1)) * (w - 4) + 2;
    const y = h - 3 - ((pts[i] - min) / span) * (h - 6);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function renderStrategyArenaView(container, {
  symbol,
  tournament,
  activeStrategyId,
  pinnedIds,
  arenaFilter,
  arenaSort,
  arenaSearch,
  onFilterChange,
  onSortChange,
  onSearchChange,
  onSelectStrategy,
  onTogglePin,
  onOpenCreator,
  onCloneStrategy,
  onDeleteCustomStrategy,
  onExportStrategies,
  onImportStrategies,
}) {
  if (!tournament?.strategies?.length) {
    container.innerHTML = `<div class="panel-empty">Running WebAssembly Strategy Tournament across all strategies…</div>`;
    return;
  }

  const all = tournament.strategies;
  const cons = tournament.consensus;
  const lastIdx = Math.max(0, cons.equalScore.length - 1);

  const summary = computeConsensusSummary(all, lastIdx);
  const { bulls, bears, holds, bullPct: bullPctNow, bearPct: bearPctNow, holdPct: holdPctNow, agreePct: agreeNow } = summary;
  const familyStats = {};
  for (const s of all) {
    const sc = s.lastScore;
    const fam = s.family || "custom";
    if (!familyStats[fam]) familyStats[fam] = { total: 0, bull: 0, bear: 0, avgScore: 0 };
    familyStats[fam].total++;
    familyStats[fam].avgScore += sc;
    if (sc >= (s.thresholds?.buy ?? 18)) familyStats[fam].bull++;
    else if (sc <= (s.thresholds?.sell ?? -18)) familyStats[fam].bear++;
  }

  const eqScoreNow = cons.equalScore[lastIdx] ?? 0;
  const shScoreNow = cons.sharpeScore[lastIdx] ?? 0;
  const eqRating = classifyScore(eqScoreNow, DEFAULT_THRESHOLDS);
  const shRating = classifyScore(shScoreNow, DEFAULT_THRESHOLDS);

  const familyCards = Object.entries(familyStats)
    .map(([famId, st]) => {
      const avg = st.avgScore / Math.max(1, st.total);
      const r = classifyScore(avg, DEFAULT_THRESHOLDS);
      const famLabel = STRATEGY_FAMILIES.find((f) => f.id === famId)?.label || famId;
      return `
        <div class="fam-align-card">
          <div class="fam-align-top">
            <span class="fam-name">${esc(famLabel)}</span>
            <span class="signal-pill ${avg >= 18 ? "bull" : avg <= -18 ? "bear" : "flat"}">${r.short}</span>
          </div>
          <div class="fam-align-sub mono">
            <span class="pos">${st.bull}▲</span> · <span class="muted">${st.total - st.bull - st.bear}—</span> · <span class="neg">${st.bear}▼</span>
            <span style="margin-left:auto">${avg >= 0 ? "+" : ""}${avg.toFixed(0)}</span>
          </div>
        </div>
      `;
    })
    .join("");

  let filtered = all.filter((s) => {
    if (arenaFilter === "custom") return s.isCustom;
    if (arenaFilter !== "all" && s.family !== arenaFilter) return false;
    if (arenaSearch) {
      const q = arenaSearch.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.family.toLowerCase().includes(q);
    }
    return true;
  });

  const sorters = {
    quant: (a, b) => b.quantRankScore - a.quantRankScore,
    sharpe: (a, b) => b.metrics.sharpe - a.metrics.sharpe,
    oos: (a, b) => (b.metrics.oosSharpe ?? -9) - (a.metrics.oosSharpe ?? -9),
    return: (a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct,
    alpha: (a, b) => (b.metrics.totalReturnPct - b.metrics.bhReturnPct) - (a.metrics.totalReturnPct - a.metrics.bhReturnPct),
    winrate: (a, b) => b.metrics.winRatePct - a.metrics.winRatePct,
    lowdd: (a, b) => a.metrics.maxDrawdownPct - b.metrics.maxDrawdownPct,
    conviction: (a, b) => b.lastScore - a.lastScore,
  };
  filtered = filtered.slice().sort(sorters[arenaSort] || sorters.quant);

  const familyPills = STRATEGY_FAMILIES.map(
    (f) => `<button class="pill-btn ${arenaFilter === f.id ? "active" : ""}" data-arena-fam="${f.id}">${f.label}</button>`
  ).join("");

  const rowsHtml = filtered
    .map((s) => {
      const m = s.metrics;
      const alpha = m.totalReturnPct - m.bhReturnPct;
      const verdict = classifyScore(s.lastScore, s.thresholds);
      const isActive = s.id === activeStrategyId;
      const isPinned = pinnedIds.includes(s.id);
      const rankClass = s.rank === 1 ? "gold" : s.rank === 2 ? "silver" : s.rank === 3 ? "bronze" : "";
      return `
        <tr class="arena-row ${isActive ? "row-active" : ""}" data-row-open="${s.id}">
          <td><span class="rank-badge ${rankClass} mono">#${s.rank}</span></td>
          <td onclick="event.stopPropagation()">
            <input type="checkbox" data-pin-strat="${s.id}" ${isPinned ? "checked" : ""} title="Pin to chart & backtest compare" />
          </td>
          <td>
            <div class="strat-cell-title">
              <strong>${esc(s.name)}</strong>
              <span class="cat-badge cat-${s.family === "reversion" ? "momentum" : s.family === "multi" ? "trend" : s.family}">${esc(s.family)}</span>
              ${s.isCustom ? `<span class="cat-badge cat-custom">CUSTOM</span>` : ""}
            </div>
            <div class="strat-cell-desc">${esc(s.description)}</div>
          </td>
          <td>
            <span class="signal-pill ${s.lastScore >= (s.thresholds?.buy ?? 18) ? "bull" : s.lastScore <= (s.thresholds?.sell ?? -18) ? "bear" : "flat"}">
              ${verdict.short} ${s.lastScore >= 0 ? "+" : ""}${s.lastScore.toFixed(0)}
            </span>
          </td>
          <td><canvas class="spark-canvas" data-spark-id="${s.id}"></canvas></td>
          <td class="mono ${m.totalReturnPct >= 0 ? "pos" : "neg"}">
            ${fmtPct(m.totalReturnPct)}
            <div class="muted" style="font-size:10px">${fmtPct(alpha)} α</div>
          </td>
          <td class="mono">
            <span class="${m.sharpe >= 1 ? "pos" : m.sharpe < 0 ? "neg" : ""}">${fmtFixed(m.sharpe, 2)}</span>
            <div class="muted" style="font-size:10px">OOS ${fmtFixed(m.oosSharpe ?? 0, 2)}</div>
          </td>
          <td class="mono neg">-${fmtFixed(m.maxDrawdownPct, 1)}%</td>
          <td class="mono">${fmtFixed(m.winRatePct, 0)}% <span class="muted">(${m.numTrades})</span></td>
          <td onclick="event.stopPropagation()">
            <div class="row-actions">
              <button class="btn-ghost-xs" data-act-strat="${s.id}:backtest" title="Backtest & Sweep">Test</button>
              <button class="btn-ghost-xs" data-act-strat="${s.id}:forecast" title="Forecast Lab">Forecast</button>
              <button class="btn-ghost-xs" data-act-strat="${s.id}:paper" title="Arm Paper Desk">Paper</button>
              <button class="btn-ghost-xs" data-clone-strat="${s.id}" title="Fork & Customize in Creator Studio">Fork</button>
              ${s.isCustom ? `<button class="btn-ghost-xs danger" data-del-strat="${s.id}" title="Delete">✕</button>` : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const eqEns = cons.equalEnsemble;
  const shEns = cons.sharpeEnsemble;

  container.innerHTML = `
    <div class="bt-shell">
      <div class="consensus-hero card tone-${eqRating.tone}">
        <div class="consensus-hero-top">
          <div>
            <div class="decision-kicker">MULTI-STRATEGY CONSENSUS · ${all.length} STRATEGIES EVALUATED IN ${tournament.elapsedMs.toFixed(1)}MS WASM (${tournament.uniqueIndicatorsCached} CACHED INDICATORS)</div>
            <div class="consensus-headline">
              <span class="consensus-verdict tone-${eqRating.tone}">${eqRating.label}</span>
              <span class="consensus-agree-pill mono">${agreeNow}% AGREEMENT · ${bulls} BULL / ${holds} HOLD / ${bears} BEAR</span>
            </div>
          </div>
          <div class="consensus-top-actions">
            <button class="btn-primary-sm" id="createStrategyBtn">+ Strategy Creator Studio</button>
            <button class="btn-ghost-sm" id="exportStratsBtn">Export</button>
            <button class="btn-ghost-sm" id="importStratsBtn">Import</button>
          </div>
        </div>

        <div class="consensus-meter-wrap">
          <div class="consensus-stacked-bar">
            <div class="cseg bull" style="width:${bullPctNow}%"></div>
            <div class="cseg flat" style="width:${holdPctNow}%"></div>
            <div class="cseg bear" style="width:${bearPctNow}%"></div>
          </div>
          <div class="consensus-meter-labels mono">
            <span class="pos">${bullPctNow}% Bullish (${bulls})</span>
            <span class="muted">${holdPctNow}% Neutral (${holds})</span>
            <span class="neg">${bearPctNow}% Bearish (${bears})</span>
          </div>
        </div>

        <div class="family-align-grid">${familyCards}</div>

        <div class="ensemble-cards">
          <div class="ensemble-card ${activeStrategyId === eqEns.id ? "active" : ""}">
            <div class="ensemble-card-head">
              <div>
                <strong>All-Strategy Consensus Ensemble (Equal Weight)</strong>
                <div class="muted-sm">Zero look-ahead: averages all ${all.length} strategies on ${symbol} equally at every bar.</div>
              </div>
              <span class="signal-pill ${eqScoreNow >= 18 ? "bull" : eqScoreNow <= -18 ? "bear" : "flat"}">${eqRating.short} ${eqScoreNow >= 0 ? "+" : ""}${eqScoreNow.toFixed(1)}</span>
            </div>
            <div class="ensemble-metrics mono">
              <span>Ret: <strong class="${eqEns.metrics.totalReturnPct >= 0 ? "pos" : "neg"}">${fmtPct(eqEns.metrics.totalReturnPct)}</strong></span>
              <span>Sharpe: <strong>${fmtFixed(eqEns.metrics.sharpe, 2)}</strong></span>
              <span>OOS SR: <strong>${fmtFixed(eqEns.metrics.oosSharpe ?? 0, 2)}</strong></span>
              <span>MaxDD: <strong class="neg">-${fmtFixed(eqEns.metrics.maxDrawdownPct, 1)}%</strong></span>
            </div>
            <div class="row-actions" style="margin-top:8px">
              <button class="btn-primary-sm" data-act-strat="${eqEns.id}:terminal">Chart Consensus</button>
              <button class="btn-ghost-xs" data-act-strat="${eqEns.id}:backtest">Backtest</button>
              <button class="btn-ghost-xs" data-act-strat="${eqEns.id}:forecast">Forecast</button>
              <button class="btn-ghost-xs" data-act-strat="${eqEns.id}:paper">Paper Trade</button>
            </div>
          </div>

          <div class="ensemble-card ${activeStrategyId === shEns.id ? "active" : ""}">
            <div class="ensemble-card-head">
              <div>
                <strong>Rolling OOS Sharpe Ensemble (Causal Rebalance)</strong>
                <div class="muted-sm">Rebalanced every 20 bars using ONLY prior trailing Sharpe (60-bar warmup · zero look-ahead).</div>
              </div>
              <span class="signal-pill ${shScoreNow >= 18 ? "bull" : shScoreNow <= -18 ? "bear" : "flat"}">${shRating.short} ${fmtFixed(shScoreNow, 1, true)}</span>
            </div>
            <div class="ensemble-metrics mono">
              <span>Ret: <strong class="${shEns.metrics.totalReturnPct >= 0 ? "pos" : "neg"}">${fmtPct(shEns.metrics.totalReturnPct)}</strong></span>
              <span>Sharpe: <strong>${fmtFixed(shEns.metrics.sharpe, 2)}</strong></span>
              <span>OOS SR: <strong>${fmtFixed(shEns.metrics.oosSharpe ?? 0, 2)}</strong></span>
              <span>MaxDD: <strong class="neg">-${fmtFixed(shEns.metrics.maxDrawdownPct, 1)}%</strong></span>
            </div>
            <div class="row-actions" style="margin-top:8px">
              <button class="btn-primary-sm" data-act-strat="${shEns.id}:terminal">Chart Ensemble</button>
              <button class="btn-ghost-xs" data-act-strat="${shEns.id}:backtest">Backtest</button>
              <button class="btn-ghost-xs" data-act-strat="${shEns.id}:forecast">Forecast</button>
              <button class="btn-ghost-xs" data-act-strat="${shEns.id}:paper">Paper Trade</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="arena-toolbar">
          <div class="cat-pills">${familyPills}</div>
          <div class="arena-toolbar-right">
            <input type="text" id="arenaSearchInput" class="search-input sm" placeholder="Filter strategies…" value="${esc(arenaSearch)}" />
            <label class="subpane-picker">
              <span class="muted-sm">Rank By</span>
              <select id="arenaSortSelect" class="mini-select">
                <option value="quant" ${arenaSort === "quant" ? "selected" : ""}>Composite Rank (70% Train + Shrinkage)</option>
                <option value="oos" ${arenaSort === "oos" ? "selected" : ""}>Held-Out 30% OOS Sharpe</option>
                <option value="sharpe" ${arenaSort === "sharpe" ? "selected" : ""}>Full-Sample Sharpe (IS)</option>
                <option value="return" ${arenaSort === "return" ? "selected" : ""}>Total Return % (IS)</option>
                <option value="alpha" ${arenaSort === "alpha" ? "selected" : ""}>Alpha vs Buy & Hold</option>
                <option value="winrate" ${arenaSort === "winrate" ? "selected" : ""}>Win Rate %</option>
                <option value="lowdd" ${arenaSort === "lowdd" ? "selected" : ""}>Lowest Max Drawdown</option>
                <option value="conviction" ${arenaSort === "conviction" ? "selected" : ""}>Live Conviction Score</option>
              </select>
            </label>
          </div>
        </div>

        <div class="muted-sm" style="margin-bottom:10px">
          <strong>Click any row</strong> to load on Terminal Chart · Pin up to 5 strategies for side-by-side comparison (${pinnedIds.length}/5 pinned). Default ranking uses strictly the 70% Train slice with Bayesian shrinkage so the final 30% OOS column stays genuinely held-out.
        </div>

        <div class="table-scroll" style="max-height:520px">
          <table class="data-table arena-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th title="Pin to chart & backtest comparison">Pin</th>
                <th>Strategy</th>
                <th>Live Verdict</th>
                <th>Equity</th>
                <th>Return / α</th>
                <th>Sharpe / OOS</th>
                <th>Max DD</th>
                <th>Win (N)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || `<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">No strategies match filter.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  container.querySelector("#createStrategyBtn")?.addEventListener("click", () => onOpenCreator?.());
  container.querySelector("#exportStratsBtn")?.addEventListener("click", () => onExportStrategies?.());
  container.querySelector("#importStratsBtn")?.addEventListener("click", () => onImportStrategies?.());
  container.querySelectorAll("[data-arena-fam]").forEach((b) => b.addEventListener("click", () => onFilterChange?.(b.dataset.arenaFam)));
  container.querySelector("#arenaSortSelect")?.addEventListener("change", (e) => onSortChange?.(e.target.value));
  container.querySelector("#arenaSearchInput")?.addEventListener("input", (e) => onSearchChange?.(e.target.value));
  container.querySelectorAll("[data-pin-strat]").forEach((cb) => cb.addEventListener("change", () => onTogglePin?.(cb.dataset.pinStrat)));
  container.querySelectorAll("[data-row-open]").forEach((tr) =>
    tr.addEventListener("click", () => onSelectStrategy?.(tr.dataset.rowOpen, "terminal"))
  );
  container.querySelectorAll("[data-act-strat]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const [id, targetView] = btn.dataset.actStrat.split(":");
      onSelectStrategy?.(id, targetView);
    })
  );
  container.querySelectorAll("[data-clone-strat]").forEach((btn) => btn.addEventListener("click", () => onCloneStrategy?.(btn.dataset.cloneStrat)));
  container.querySelectorAll("[data-del-strat]").forEach((btn) => btn.addEventListener("click", () => onDeleteCustomStrategy?.(btn.dataset.delStrat)));

  const byId = new Map(all.map((s) => [s.id, s]));
  requestAnimationFrame(() => {
    container.querySelectorAll(".spark-canvas").forEach((c) => {
      const s = byId.get(c.dataset.sparkId);
      if (s) drawSparkline(c, s.sparkline);
    });
  });
}

// ============================================================================
// LIVE-FEEDBACK STRATEGY CREATOR STUDIO (Real-time <1ms WASM Preview!)
// ============================================================================
export function openStrategyCreatorModal({ initialStrategy = null, liveSignals = {}, onPreviewDraft, onSaveStrategy }) {
  const existing = document.getElementById("strategyCreatorModal");
  if (existing) existing.remove();

  const draft = {
    id: initialStrategy?.isCustom ? initialStrategy.id : `custom_${Date.now().toString(36)}`,
    name: initialStrategy ? `${initialStrategy.name}${initialStrategy.isCustom ? "" : " (Copy)"}` : "My Quant Strategy",
    family: initialStrategy?.family || "custom",
    description: initialStrategy?.description || "Custom indicator composite built in Risk Strategy Creator.",
    isCustom: true,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(initialStrategy?.thresholds || {}) },
    rules: initialStrategy?.rules?.length
      ? initialStrategy.rules.map((x) => ({ ...x, uid: `${x.key}_${Math.random().toString(36).slice(2, 6)}`, params: { ...x.params } }))
      : [
          createRuleFromCatalog("ema_cross", { weight: 2.0 }),
          createRuleFromCatalog("rsi", { weight: 1.5 }),
          createRuleFromCatalog("cmf", { weight: 1.5 }),
        ],
  };

  let catFilter = "all";
  let indSearch = "";

  const overlay = document.createElement("div");
  overlay.id = "strategyCreatorModal";
  overlay.className = "modal-backdrop";

  const refreshLivePreview = async () => {
    const strip = overlay.querySelector("#crLivePreviewStrip");
    if (!strip || !onPreviewDraft) return;
    const prev = await onPreviewDraft(draft);
    if (!prev) {
      strip.innerHTML = `<span class="muted-sm">Add at least 1 indicator to see live WASM performance preview.</span>`;
      return;
    }
    const r = classifyScore(prev.lastScore, draft.thresholds);
    const m = prev.metrics;
    strip.innerHTML = `
      <div class="live-prev-item">
        <span class="kpi-label">LIVE SIGNAL</span>
        <span class="signal-pill ${prev.lastScore >= draft.thresholds.buy ? "bull" : prev.lastScore <= draft.thresholds.sell ? "bear" : "flat"}">${r.label} (${prev.lastScore >= 0 ? "+" : ""}${prev.lastScore.toFixed(1)})</span>
      </div>
      <div class="live-prev-item">
        <span class="kpi-label">PROJECTED RANK</span>
        <strong class="mono pos">#${prev.projectedRank} of ${prev.totalRanked}</strong>
      </div>
      <div class="live-prev-item">
        <span class="kpi-label">RETURN / SHARPE</span>
        <strong class="mono ${m.totalReturnPct >= 0 ? "pos" : "neg"}">${fmtPct(m.totalReturnPct)} · SR ${fmtFixed(m.sharpe, 2)}</strong>
      </div>
      <div class="live-prev-item">
        <span class="kpi-label">OOS SR / MAX DD</span>
        <strong class="mono">${fmtFixed(m.oosSharpe ?? 0, 2)} · <span class="neg">-${fmtFixed(m.maxDrawdownPct, 1)}%</span> (${plural(m.numTrades, "trade")})${m.numTrades < 5 ? ` <span class="signal-pill veto" title="Fewer than 5 closed trades — high statistical noise">LOW N</span>` : ""}</strong>
      </div>
      <canvas id="crPreviewSpark" width="96" height="26"></canvas>
    `;
    requestAnimationFrame(() => drawSparkline(overlay.querySelector("#crPreviewSpark"), prev.sparkline, 96, 26));
  };

  const render = () => {
    const filteredInds = INDICATOR_CATALOG.filter((item) => {
      if (catFilter !== "all" && item.category !== catFilter) return false;
      if (indSearch) {
        const q = indSearch.toLowerCase();
        return item.name.toLowerCase().includes(q) || item.shortName.toLowerCase().includes(q);
      }
      return true;
    });

    const catBtns = INDICATOR_CATEGORIES.map(
      (c) => `<button class="pill-btn ${catFilter === c.id ? "active" : ""}" data-cr-cat="${c.id}">${c.label}</button>`
    ).join("");

    const indListHtml = filteredInds
      .map((item) => {
        const sig = liveSignals[item.key];
        const dot =
          sig === undefined ? ""
          : sig > 0.15 ? `<span class="pos mono" style="font-size:10px" title="Currently bullish">▲</span>`
          : sig < -0.15 ? `<span class="neg mono" style="font-size:10px" title="Currently bearish">▼</span>`
          : `<span class="muted mono" style="font-size:10px">—</span>`;
        const usedCnt = draft.rules.filter((x) => x.key === item.key).length;
        return `
          <div class="cr-ind-row">
            <div style="display:flex;align-items:center;gap:6px;min-width:0">
              ${dot}
              <strong style="white-space:nowrap">${esc(item.shortName)}</strong>
              <span class="muted-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
              ${usedCnt > 0 ? `<span class="added-chip">✓ ×${usedCnt}</span>` : ""}
              <button class="btn-ghost-xs" data-cr-add="${item.key}">+ Add</button>
            </div>
          </div>
        `;
      })
      .join("");

    const draftRulesHtml = draft.rules
      .map((rule, idx) => {
        const meta = INDICATOR_BY_ID.get(rule.indicatorId);
        if (!meta) return "";
        const paramsHtml = meta.params
          .map(
            (p) => `
            <label class="param-field">
              <span>${esc(p.label)} (${p.min}–${p.max})</span>
              <input type="number" class="mono" data-cr-param="${idx}:${p.key}" value="${rule.params[p.key]}" min="${p.min}" max="${p.max}" step="${p.step}" />
            </label>
          `
          )
          .join("");
        return `
          <div class="rule-card">
            <div class="rule-card-head">
              <span class="rule-title">${esc(meta.shortName)}</span>
              <span class="cat-badge cat-${meta.category}">${meta.category}</span>
              <div class="rule-head-actions">
                <button class="chip-toggle ${rule.invert ? "active invert-on" : ""}" data-cr-inv="${idx}">${rule.invert ? "⇄ INV ON" : "⇄ Invert"}</button>
                <button class="icon-btn danger" data-cr-rm="${idx}">✕</button>
              </div>
            </div>
            <div class="rule-controls-row">
              <div class="weight-control">
                <span class="ctrl-lbl">Weight <strong class="mono">${Number(rule.weight).toFixed(1)}x</strong></span>
                <input type="range" min="0.1" max="5" step="0.1" value="${rule.weight}" data-cr-w="${idx}" />
              </div>
              <select class="mini-select" data-cr-mode="${idx}" title="Strength = continuous weight; Trigger = binary TRUE/FALSE; Veto Gate = dampens opposing trades">
                <option value="0" ${rule.mode === 0 ? "selected" : ""}>Strength</option>
                <option value="1" ${rule.mode === 1 ? "selected" : ""}>Trigger</option>
                <option value="2" ${rule.mode === 2 ? "selected" : ""}>Veto Gate</option>
              </select>
            </div>
            <div class="rule-params-row">${paramsHtml}</div>
          </div>
        `;
      })
      .join("");

    overlay.innerHTML = `
      <div class="modal-sheet creator-sheet">
        <div class="modal-header">
          <div>
            <h3>Strategy Creator Studio</h3>
            <p class="muted-sm">Compose from all ${INDICATOR_CATALOG.length} WebAssembly indicators with instant live WASM performance &amp; rank preview. Press Esc to close.</p>
          </div>
          <button class="icon-btn" id="crCloseBtn">✕</button>
        </div>

        <!-- LIVE WASM PREVIEW STRIP -->
        <div class="creator-live-strip" id="crLivePreviewStrip">
          <span class="muted-sm">Evaluating draft in WebAssembly…</span>
        </div>

        <div class="creator-meta-row">
          <label><span>Strategy Name</span><input type="text" id="crName" value="${esc(draft.name)}" /></label>
          <label>
            <span>Family</span>
            <select id="crFamily" class="full-select">
              <option value="custom" ${draft.family === "custom" ? "selected" : ""}>Custom</option>
              <option value="multi" ${draft.family === "multi" ? "selected" : ""}>Multi-Factor</option>
              <option value="trend" ${draft.family === "trend" ? "selected" : ""}>Trend</option>
              <option value="momentum" ${draft.family === "momentum" ? "selected" : ""}>Momentum</option>
              <option value="reversion" ${draft.family === "reversion" ? "selected" : ""}>Mean Reversion</option>
              <option value="volatility" ${draft.family === "volatility" ? "selected" : ""}>Volatility &amp; Breakout</option>
              <option value="volume" ${draft.family === "volume" ? "selected" : ""}>Volume Flow</option>
            </select>
          </label>
          <label><span>Buy ≥</span><input type="number" class="mono" id="crBuyT" value="${draft.thresholds.buy}" min="5" max="75" /></label>
          <label><span>Sell ≤</span><input type="number" class="mono" id="crSellT" value="${draft.thresholds.sell}" min="-75" max="-5" /></label>
        </div>
        <div style="padding:0 18px 10px">
          <input type="text" id="crDesc" class="search-input" style="width:100%" placeholder="Short thesis / description…" value="${esc(draft.description)}" />
        </div>

        <div class="creator-split">
          <div class="creator-left">
            <div class="section-mini-head"><span>PICK FROM ${INDICATOR_CATALOG.length} INDICATORS (LIVE ▲/▼)</span></div>
            <input type="text" id="crIndSearch" class="search-input" style="width:100%;margin-bottom:8px" placeholder="Search KAMA, Ichimoku, TSI, Klinger, Ulcer…" value="${esc(indSearch)}" />
            <div class="cat-pills" style="margin-bottom:8px">${catBtns}</div>
            <div class="cr-ind-list">${indListHtml}</div>
          </div>

          <div class="creator-right">
            <div class="section-mini-head"><span>ACTIVE RULES (${draft.rules.length})</span></div>
            <div class="rules-stack">${draftRulesHtml || `<div class="panel-empty-sm">Add indicators from the left panel to build your strategy.</div>`}</div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-ghost-sm" id="crCancelBtn">Cancel</button>
          <button class="btn-primary-sm" id="crSaveBtn">Save &amp; Rank on Leaderboard</button>
        </div>
      </div>
    `;

    overlay.querySelector("#crCloseBtn")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#crCancelBtn")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#crName")?.addEventListener("input", (e) => { draft.name = e.target.value; });
    overlay.querySelector("#crFamily")?.addEventListener("change", (e) => { draft.family = e.target.value; });
    overlay.querySelector("#crDesc")?.addEventListener("input", (e) => { draft.description = e.target.value; });
    overlay.querySelector("#crBuyT")?.addEventListener("change", (e) => {
      draft.thresholds.buy = Number(e.target.value);
      draft.thresholds.strongBuy = Math.min(95, Math.max(draft.thresholds.buy + 22, 48));
      refreshLivePreview();
    });
    overlay.querySelector("#crSellT")?.addEventListener("change", (e) => {
      draft.thresholds.sell = Number(e.target.value);
      draft.thresholds.strongSell = Math.max(-95, Math.min(draft.thresholds.sell - 22, -48));
      refreshLivePreview();
    });

    overlay.querySelector("#crIndSearch")?.addEventListener("input", (e) => {
      indSearch = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = overlay.querySelector("#crIndSearch");
      inp?.focus();
      inp?.setSelectionRange(pos, pos);
    });
    overlay.querySelectorAll("[data-cr-cat]").forEach((b) =>
      b.addEventListener("click", () => { catFilter = b.dataset.crCat; render(); })
    );
    overlay.querySelectorAll("[data-cr-add]").forEach((b) =>
      b.addEventListener("click", () => { draft.rules.push(createRuleFromCatalog(b.dataset.crAdd)); render(); })
    );
    overlay.querySelectorAll("[data-cr-rm]").forEach((b) =>
      b.addEventListener("click", () => { draft.rules.splice(Number(b.dataset.crRm), 1); render(); })
    );
    overlay.querySelectorAll("[data-cr-inv]").forEach((b) =>
      b.addEventListener("click", () => {
        const i = Number(b.dataset.crInv);
        draft.rules[i].invert = !draft.rules[i].invert;
        render();
      })
    );
    overlay.querySelectorAll("[data-cr-w]").forEach((rng) => {
      rng.addEventListener("input", () => {
        const i = Number(rng.dataset.crW);
        draft.rules[i].weight = Number(rng.value);
        const lbl = rng.previousElementSibling?.querySelector("strong");
        if (lbl) lbl.textContent = `${Number(rng.value).toFixed(1)}x`;
        refreshLivePreview();
      });
    });
    overlay.querySelectorAll("[data-cr-mode]").forEach((sel) =>
      sel.addEventListener("change", () => { draft.rules[Number(sel.dataset.crMode)].mode = Number(sel.value); refreshLivePreview(); })
    );
    overlay.querySelectorAll("[data-cr-param]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const [idx, key] = inp.dataset.crParam.split(":");
        draft.rules[Number(idx)].params[key] = Number(inp.value);
        refreshLivePreview();
      })
    );

    overlay.querySelector("#crSaveBtn")?.addEventListener("click", () => {
      if (!draft.name.trim()) draft.name = "Untitled Strategy";
      if (!draft.rules.length) return;
      onSaveStrategy?.(draft);
      overlay.remove();
    });

    refreshLivePreview();
  };

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  render();
  document.body.appendChild(overlay);
}
