import { INDICATOR_BY_ID } from "../data/indicators.js";
import { classifyScore, DEFAULT_THRESHOLDS } from "../data/strategies.js";
import { computeConsensusSummary } from "./format.js";

const FAMILY_META = [
  { id: "trend", tag: "TRD", label: "Trend" },
  { id: "momentum", tag: "MOM", label: "Momentum" },
  { id: "reversion", tag: "MR", label: "Mean Rev" },
  { id: "volatility", tag: "VOL", label: "Volatility" },
  { id: "volume", tag: "FLW", label: "Volume" },
  { id: "multi", tag: "MF", label: "Multi" },
  { id: "custom", tag: "CST", label: "Custom" },
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

export function renderDecisionPanel(container, {
  symbol,
  activeStrategyName,
  isEnsembleMode,
  railTab,
  bars,
  activeIdx,
  rules,
  ruleResults,
  score,
  thresholds,
  forecast,
  tournament,
  onQuickTrade,
  onOpenArena,
  onSwitchStrategy,
  onChangeRailTab,
}) {
  if (!bars?.length || !score?.length) {
    container.innerHTML = `<div class="panel-empty">Awaiting market data…</div>`;
    return;
  }

  const idx = activeIdx >= 0 && activeIdx < bars.length ? activeIdx : bars.length - 1;
  const isHistorical = activeIdx >= 0 && activeIdx < bars.length - 1;
  const currentScore = Number.isFinite(score[idx]) ? score[idx] : 0;
  const rating = classifyScore(currentScore, thresholds);
  const price = bars[idx].c;

  // Family-Grouped Multi-Strategy Consensus Matrix at the active/hovered bar
  let consensusStripHtml = "";
  let strategyVoteRows = "";
  if (tournament?.strategies?.length) {
    const strats = tournament.strategies;
    let sBull = 0; let sBear = 0; let sHold = 0;
    for (const s of strats) {
      const sc = s.score[idx] ?? 0;
      if (sc >= (s.thresholds?.buy ?? 18)) sBull++;
      else if (sc <= (s.thresholds?.sell ?? -18)) sBear++;
      else sHold++;
    }

    const familyGroupsHtml = FAMILY_META.map((fm) => {
      const members = strats
        .filter((s) => (s.family || "custom") === fm.id)
        .sort((a, b) => (b.score[idx] ?? 0) - (a.score[idx] ?? 0));
      if (!members.length) return "";
      const dots = members
        .map((s) => {
          const sc = s.score[idx] ?? 0;
          const cls = sc >= (s.thresholds?.buy ?? 18) ? "bull" : sc <= (s.thresholds?.sell ?? -18) ? "bear" : "flat";
          return `<button class="mini-vote-dot ${cls}" data-dot-strat="${s.id}" title="#${s.rank} ${escapeHtml(s.name)} (${fm.label}): ${sc >= 0 ? "+" : ""}${sc.toFixed(0)}"></button>`;
        })
        .join("");
      return `
        <div class="fam-dot-cluster" title="${fm.label}">
          <span class="fam-dot-lbl mono">${fm.tag}</span>
          <div class="fam-dot-row">${dots}</div>
        </div>
      `;
    }).join("");

    const cs = computeConsensusSummary(strats, idx);
    const consScore = tournament.consensus.equalScore[idx] ?? 0;
    const consRating = classifyScore(consScore, DEFAULT_THRESHOLDS);

    consensusStripHtml = `
      <div class="consensus-mini-box">
        <div class="consensus-mini-head">
          <span>STRATEGIES (${cs.total}) · ${cs.agreePct}% ALIGNED</span>
          <button class="link-btn" id="openArenaFromCardBtn">Arena →</button>
        </div>
        <div class="consensus-mini-body">
          <span class="signal-pill ${consScore >= 18 ? "bull" : consScore <= -18 ? "bear" : "flat"}">${consRating.short}</span>
          <span class="mono muted-sm"><strong class="pos">${cs.bulls}▲</strong> · ${cs.holds}— · <strong class="neg">${cs.bears}▼</strong></span>
        </div>
        <div class="fam-vote-clusters">${familyGroupsHtml}</div>
      </div>
    `;

    if (isEnsembleMode) {
      strategyVoteRows = strats
        .map((s) => {
          const sc = s.score[idx] ?? 0;
          const norm = Math.max(-1, Math.min(1, sc / 100));
          const barW = Math.min(50, Math.abs(norm) * 50);
          const barLeft = norm >= 0 ? 50 : 50 - barW;
          const r = classifyScore(sc, s.thresholds);
          const cls = sc >= (s.thresholds?.buy ?? 18) ? "bull" : sc <= (s.thresholds?.sell ?? -18) ? "bear" : "flat";
          return `
            <div class="attr-row clickable" data-dot-strat="${s.id}">
              <div class="attr-row-top">
                <span class="attr-name">#${s.rank} ${escapeHtml(s.name)}</span>
                <span class="signal-pill ${cls}">${r.short}</span>
              </div>
              <div class="attr-row-bot">
                <div class="strength-track">
                  <div class="strength-zero"></div>
                  <div class="strength-fill ${norm >= 0 ? "pos" : "neg"}" style="left:${barLeft.toFixed(1)}%;width:${barW.toFixed(1)}%"></div>
                </div>
                <span class="attr-contrib mono">${sc >= 0 ? "+" : ""}${sc.toFixed(0)}</span>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  // Per-indicator rule attribution
  const resultMap = new Map(ruleResults.map((r) => [r.uid, r]));
  let bullCount = 0; let bearCount = 0; let neutralCount = 0; let totalWeight = 0;
  const rows = [];
  if (!isEnsembleMode) {
    for (const r of rules) {
      if (!r.enabled) continue;
      const meta = INDICATOR_BY_ID.get(r.indicatorId);
      const res = resultMap.get(r.uid);
      if (!meta || !res) continue;

      const rawSig = res.sig[idx] ?? 0;
      let effectiveSig = rawSig;
      const isTriggered = Math.abs(rawSig) >= (r.triggerThresh ?? 0.35);
      if (r.mode === 1) effectiveSig = rawSig >= r.triggerThresh ? 1 : rawSig <= -r.triggerThresh ? -1 : 0;

      if (r.mode !== 2) {
        totalWeight += r.weight;
        if (effectiveSig > 0.12) bullCount++;
        else if (effectiveSig < -0.12) bearCount++;
        else neutralCount++;
      }

      rows.push({
        uid: r.uid,
        meta,
        rule: r,
        rawSig,
        effectiveSig,
        isTriggered,
        formatted: meta.formatValue(res.lines.map((arr) => arr[idx])),
      });
    }
  } else if (tournament?.strategies?.length) {
    for (const s of tournament.strategies) {
      const sc = s.score[idx] ?? 0;
      if (sc >= (s.thresholds?.buy ?? 18)) bullCount++;
      else if (sc <= (s.thresholds?.sell ?? -18)) bearCount++;
      else neutralCount++;
    }
  }

  // Sleek Horizontal Precision Conviction Bar (-100 .. +100 -> 0% .. 100%)
  const pctPos = Math.max(2, Math.min(98, ((currentScore + 100) / 200) * 100));
  const buyTick = ((thresholds.buy + 100) / 200) * 100;
  const sellTick = ((thresholds.sell + 100) / 200) * 100;

  const forecastChip = forecast
    ? `<div class="forecast-mini-strip">
         <span>${forecast.horizon}-bar Causal Forecast</span>
         <strong class="mono ${forecast.pUpPct >= 52 ? "pos" : forecast.pUpPct <= 48 ? "neg" : ""}">
           P(Up) ${forecast.pUpPct.toFixed(1)}% · ${forecast.expectedReturnPct >= 0 ? "+" : ""}${forecast.expectedReturnPct.toFixed(2)}%
         </strong>
       </div>`
    : "";

  const attributionRows = isEnsembleMode
    ? strategyVoteRows
    : rows
        .map((row) => {
          const pct = Math.round(row.effectiveSig * 100);
          const contrib =
            row.rule.mode === 2
              ? "VETO"
              : totalWeight > 0
              ? `${((row.effectiveSig * row.rule.weight) / totalWeight) * 100 >= 0 ? "+" : ""}${(
                  ((row.effectiveSig * row.rule.weight) / totalWeight) *
                  100
                ).toFixed(1)}`
              : "0.0";
          const badgeClass =
            row.rule.mode === 2 ? "veto" : row.effectiveSig > 0.15 ? "bull" : row.effectiveSig < -0.15 ? "bear" : "flat";
          const badgeLabel =
            row.rule.mode === 2
              ? row.rawSig < -(row.rule.vetoThresh ?? 0.25) ? "DAMPEN BUY"
                : row.rawSig > (row.rule.vetoThresh ?? 0.25) ? "DAMPEN SELL" : "CLEAR"
              : row.rule.mode === 1
              ? row.isTriggered ? (row.effectiveSig > 0 ? "TRUE ▲" : "TRUE ▼") : "FALSE"
              : row.effectiveSig > 0.45 ? "STR BULL"
              : row.effectiveSig > 0.15 ? "BULL"
              : row.effectiveSig < -0.45 ? "STR BEAR"
              : row.effectiveSig < -0.15 ? "BEAR"
              : "NEUTRAL";

          const barW = Math.min(50, Math.abs(row.effectiveSig) * 50);
          const barLeft = row.effectiveSig >= 0 ? 50 : 50 - barW;

          return `
            <div class="attr-row">
              <div class="attr-row-top">
                <span class="attr-name">${escapeHtml(row.meta.shortName)}${row.rule.invert ? ' <em class="inv-tag">INV</em>' : ""}</span>
                <span class="attr-val mono">${escapeHtml(row.formatted)}</span>
                <span class="signal-pill ${badgeClass}">${badgeLabel}</span>
              </div>
              <div class="attr-row-bot">
                <div class="strength-track" title="Signal strength: ${pct}%">
                  <div class="strength-zero"></div>
                  <div class="strength-fill ${row.effectiveSig >= 0 ? "pos" : "neg"}" style="left:${barLeft.toFixed(1)}%;width:${barW.toFixed(1)}%"></div>
                </div>
                <span class="attr-contrib mono">${contrib}</span>
              </div>
            </div>
          `;
        })
        .join("");

  container.innerHTML = `
    <div class="decision-card tone-${rating.tone}">
      <div class="decision-header">
        <div style="min-width:0">
          <div class="decision-kicker" title="${escapeHtml(activeStrategyName || "Custom")}">${isHistorical ? "HISTORICAL BAR" : "ACTIVE"} · ${escapeHtml(activeStrategyName || "Custom")}</div>
          <div class="decision-verdict">${rating.label}</div>
        </div>
        <div class="decision-score-box">
          <div class="decision-score mono">${currentScore >= 0 ? "+" : ""}${currentScore.toFixed(1)}</div>
          <div class="decision-score-sub">SCORE</div>
        </div>
      </div>

      <!-- Compact Precision Horizontal Conviction Bar -->
      <div class="hbar-wrap">
        <div class="hbar-track">
          <div class="hbar-tick" style="left:${sellTick.toFixed(1)}%" title="Sell ≤ ${thresholds.sell}"></div>
          <div class="hbar-tick center" style="left:50%"></div>
          <div class="hbar-tick" style="left:${buyTick.toFixed(1)}%" title="Buy ≥ ${thresholds.buy}"></div>
          <div class="hbar-marker" style="left:${pctPos.toFixed(1)}%"></div>
        </div>
        <div class="hbar-labels mono">
          <span>-100</span>
          <span>${isEnsembleMode ? "Strategies" : "Indicators"}: <strong class="pos">${bullCount}▲</strong> · ${neutralCount}— · <strong class="neg">${bearCount}▼</strong></span>
          <span>+100</span>
        </div>
      </div>

      ${consensusStripHtml}
      ${forecastChip}

      <div class="quick-trade-bar">
        <button class="btn-trade buy" data-quick-side="buy">Paper Buy · $${price.toFixed(2)}</button>
        <button class="btn-trade sell" data-quick-side="sell">Paper Sell</button>
      </div>
    </div>

    <!-- Right Rail Switcher: Attribution vs Edit Strategy (Both Above the Fold!) -->
    <div class="rail-tabs">
      <button class="rail-tab ${railTab === "attribution" ? "active" : ""}" data-rail-tab="attribution">
        ${isEnsembleMode ? "Strategy Votes" : `Attribution (${rows.length})`}
      </button>
      <button class="rail-tab ${railTab === "edit" ? "active" : ""}" data-rail-tab="edit">
        Edit Strategy
      </button>
    </div>

    ${
      railTab === "attribution"
        ? `<div class="attribution-card">
             <div class="section-mini-head">
               <span>${isEnsembleMode ? "CONSTITUENT STRATEGY VOTES" : "INDICATOR ATTRIBUTION"}</span>
               <span class="mono muted">STRENGTH · PTS</span>
             </div>
             <div class="attr-list">
               ${attributionRows || `<div class="muted-sm">Enable indicators in Edit Strategy to compute conviction.</div>`}
             </div>
           </div>`
        : ""
    }
  `;

  container.querySelectorAll("[data-quick-side]").forEach((btn) =>
    btn.addEventListener("click", () => onQuickTrade?.(btn.dataset.quickSide, price))
  );
  container.querySelector("#openArenaFromCardBtn")?.addEventListener("click", () => onOpenArena?.());
  container.querySelectorAll("[data-dot-strat]").forEach((el) =>
    el.addEventListener("click", () => onSwitchStrategy?.(el.dataset.dotStrat))
  );
  container.querySelectorAll("[data-rail-tab]").forEach((btn) =>
    btn.addEventListener("click", () => onChangeRailTab?.(btn.dataset.railTab))
  );
}
