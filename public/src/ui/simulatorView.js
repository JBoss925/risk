import { INDICATOR_BY_ID } from "../data/indicators.js";
import { classifyScore, DEFAULT_THRESHOLDS } from "../data/strategies.js";
import { SIM_PAUSE_MODES, SIM_TIME_PRESETS } from "../data/simEngine.js";
import { computeConsensusSummary, fmtFixed, fmtPct, fmtMoney, cleanZero, plural } from "./format.js";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function fmtBarTime(ms, interval) {
  if (!ms) return "—";
  const d = new Date(ms);
  if (interval && (interval.endsWith("m") || interval === "1h")) {
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export function renderSimulatorDeck(container, {
  sim,
  simState,
  fullBars,
  interval,
  range,
  onPlayToggle,
  onStep,
  onNextPrompt,
  onSpeedChange,
  onScrubStart,
  onRandomStart,
  onResetSim,
  onSelectPreset,
  onPauseModeChange,
  onFillModeChange,
}) {
  if (!container) return;
  const total = fullBars.length;
  const minCursor = Math.min(total, Math.max(45, Math.min(70, Math.floor(total * 0.25))));
  const cursor = Math.min(total, Math.max(minCursor, simState.cursor || minCursor));
  const curBar = fullBars[cursor - 1];
  const atEnd = cursor >= total;
  const bigJumpLabel = interval === "5m" ? "+1h" : interval === "15m" ? "+1d" : interval === "1h" ? "+1d" : "+1w";
  const bigJumpBars = interval === "5m" ? 12 : interval === "15m" ? 26 : interval === "1h" ? 7 : 5;

  const presetBtns = SIM_TIME_PRESETS.map((p) => {
    const active = p.interval === interval && p.range === range;
    return `<button class="pill-btn ${active ? "active" : ""}" data-sim-preset="${p.id}" title="${esc(p.title)}">${p.label}</button>`;
  }).join("");

  const modeOpts = SIM_PAUSE_MODES.map(
    (m) => `<option value="${m.id}" ${sim.pauseMode === m.id ? "selected" : ""}>${esc(m.label)}</option>`
  ).join("");

  container.innerHTML = `
    <div class="sim-deck-top">
      <div class="sim-transport">
        <button class="btn-primary-sm" id="simPlayBtn" ${atEnd ? "disabled" : ""} title="Play / Pause (Space)">
          ${simState.playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button class="btn-ghost-xs mono" id="simStep1Btn" ${atEnd ? "disabled" : ""} title="Advance 1 bar (→)">+1 Bar</button>
        <button class="btn-ghost-xs mono" id="simStep5Btn" ${atEnd ? "disabled" : ""} title="Advance 5 bars">+5</button>
        <button class="btn-ghost-xs mono" id="simStepJumpBtn" ${atEnd ? "disabled" : ""} title="Advance ${bigJumpBars} bars">${bigJumpLabel}</button>
        <button class="btn-ghost-xs sim-next-sig-btn" id="simNextPromptBtn" ${atEnd ? "disabled" : ""} title="Fast-forward until Co-Pilot trigger pauses">⏭ Next Prompt</button>
        <select id="simSpeedSelect" class="mini-select" title="Playback speed">
          <option value="1400" ${simState.speedMs === 1400 ? "selected" : ""}>0.5x</option>
          <option value="700" ${simState.speedMs === 700 ? "selected" : ""}>1x</option>
          <option value="340" ${simState.speedMs === 340 ? "selected" : ""}>2x</option>
          <option value="140" ${simState.speedMs === 140 ? "selected" : ""}>5x</option>
          <option value="65" ${simState.speedMs === 65 ? "selected" : ""}>10x</option>
        </select>
      </div>

      <div class="sim-scrubber-wrap">
        <span class="mono sim-date-pill" title="Current simulated timestamp">${fmtBarTime(curBar?.t, interval)}</span>
        <input type="range" id="simScrubRange" min="${minCursor}" max="${Math.max(minCursor, total)}" value="${cursor}" title="Scrub historical start point (resets session from chosen bar)" />
        <span class="mono muted-sm" style="white-space:nowrap">${cursor}/${total}</span>
      </div>

      <div class="sim-deck-actions">
        <button class="btn-ghost-xs" id="simRandomBtn" title="Jump to a random historical start point for blind practice">🎲 Random</button>
        <button class="btn-ghost-xs" id="simResetBtn" title="Reset $100k simulator wallet at current start bar">Reset $100k</button>
      </div>
    </div>

    <div class="sim-deck-sub">
      <div class="sim-preset-row">
        <span class="bar-tag">SESSION</span>
        ${presetBtns}
      </div>
      <div class="sim-copilot-cfg">
        <label class="subpane-picker">
          <span class="bar-tag">CO-PILOT</span>
          <select id="simPauseModeSel" class="mini-select">${modeOpts}</select>
        </label>
        <div class="segmented" id="simFillModeGroup" title="Order execution timing">
          <button data-fill-mode="close" class="${sim.fillMode === "close" ? "active" : ""}">Instant Close</button>
          <button data-fill-mode="next_open" class="${sim.fillMode === "next_open" ? "active" : ""}">Next Open</button>
        </div>
      </div>
    </div>
  `;

  container.querySelector("#simPlayBtn")?.addEventListener("click", () => onPlayToggle?.());
  container.querySelector("#simStep1Btn")?.addEventListener("click", () => onStep?.(1));
  container.querySelector("#simStep5Btn")?.addEventListener("click", () => onStep?.(5));
  container.querySelector("#simStepJumpBtn")?.addEventListener("click", () => onStep?.(bigJumpBars));
  container.querySelector("#simNextPromptBtn")?.addEventListener("click", () => onNextPrompt?.());
  container.querySelector("#simSpeedSelect")?.addEventListener("change", (e) => onSpeedChange?.(Number(e.target.value)));
  container.querySelector("#simScrubRange")?.addEventListener("change", (e) => onScrubStart?.(Number(e.target.value)));
  container.querySelector("#simRandomBtn")?.addEventListener("click", () => onRandomStart?.());
  container.querySelector("#simResetBtn")?.addEventListener("click", () => onResetSim?.());
  container.querySelectorAll("[data-sim-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = SIM_TIME_PRESETS.find((x) => x.id === b.dataset.simPreset);
      if (p) onSelectPreset?.(p);
    })
  );
  container.querySelector("#simPauseModeSel")?.addEventListener("change", (e) => onPauseModeChange?.(e.target.value));
  container.querySelectorAll("[data-fill-mode]").forEach((b) =>
    b.addEventListener("click", () => onFillModeChange?.(b.dataset.fillMode))
  );
}

export function renderSimulatorRail(container, {
  symbol,
  interval,
  activeStrategyName,
  isEnsembleMode,
  sim,
  simState,
  bars,
  activeIdx,
  rules,
  ruleResults,
  score,
  thresholds,
  forecast,
  tournament,
  onUserTrade,
  onCancelPending,
  onPromptAccept,
  onPromptSkip,
  onPromptDismiss,
  onChangeSizePct,
  onUpdateBracket,
  onToggleAllowShort,
  onChangeRailTab,
  onSwitchStrategy,
}) {
  if (!container) return;
  const n = bars.length;
  if (!n) {
    container.innerHTML = `<div class="panel-empty">Loading historical bars for Simulator…</div>`;
    return;
  }

  const idx = activeIdx >= 0 && activeIdx < n ? activeIdx : n - 1;
  const curBar = bars[n - 1];
  const markPx = curBar.c;
  const curScore = score?.[idx] ?? 0;
  const rating = classifyScore(curScore, thresholds);
  const stats = sim.getStats(markPx);
  const pos = sim.position;
  const prompt = simState.activePrompt;

  // 1. Illuminated Co-Pilot Prompt Card (when paused on a signal!)
  let promptHtml = "";
  if (prompt) {
    const isBuy = prompt.kind === "buy";
    const driverChips = (prompt.drivers || [])
      .map((d) => {
        const meta = INDICATOR_BY_ID.get(rules.find((r) => r.key === d.key)?.indicatorId);
        const lbl = meta?.shortName || d.key.toUpperCase();
        return `<span class="signal-pill ${d.signal > 0.1 ? "bull" : d.signal < -0.1 ? "bear" : "flat"}">${esc(lbl)} ${d.contrib >= 0 ? "+" : ""}${d.contrib.toFixed(1)}</span>`;
      })
      .join("");
    const primaryLabel = isBuy
      ? `Accept & Buy (${simState.sizePct}%)`
      : pos && pos.qty > 0
      ? `Accept & Flatten Long`
      : sim.allowShort
      ? `Accept & Short (${simState.sizePct}%)`
      : `Accept & Stay Flat`;
    promptHtml = `
      <div class="sim-prompt-card tone-${isBuy ? "buy" : "sell"}">
        <div class="sim-prompt-head">
          <span class="sim-prompt-badge">⏸ CO-PILOT PROMPT · BAR ${prompt.barIdx + 1}</span>
          <button class="icon-btn" id="simPromptDismissBtn" title="Dismiss prompt and stay paused">✕</button>
        </div>
        <div class="sim-prompt-title">${esc(prompt.headline)}</div>
        <div class="muted-sm" style="margin-bottom:8px">
          ${esc(prompt.detail)} at <strong class="mono">$${prompt.price.toFixed(2)}</strong>
          ${prompt.consensus ? ` · Consensus <strong class="mono">${prompt.consensus.agreePct}%</strong> (${prompt.consensus.bulls}▲/${prompt.consensus.bears}▼)` : ""}
        </div>
        ${driverChips ? `<div class="sim-driver-chips">${driverChips}</div>` : ""}
        <div class="sim-prompt-actions">
          <button class="btn-trade ${isBuy ? "buy" : "sell"}" id="simPromptAcceptBtn">${primaryLabel}</button>
          <button class="btn-ghost-sm" id="simPromptSkipBtn">Ignore &amp; Continue ▶</button>
        </div>
      </div>
    `;
  }

  // 2. Manual Discretionary Trade Pad
  const sizePills = [10, 25, 50, 100]
    .map((pct) => `<button class="pill-btn ${simState.sizePct === pct ? "active" : ""}" data-sim-size="${pct}">${pct}%</button>`)
    .join("");

  const posHtml = pos
    ? (() => {
        const uPnl = (markPx - pos.avgPrice) * pos.qty - (pos.entryFeeRemaining || 0);
        const uPct = pos.avgPrice > 0 ? ((markPx - pos.avgPrice) / pos.avgPrice) * 100 * Math.sign(pos.qty) : 0;
        const slTp = [
          pos.stopLossPrice ? `SL $${pos.stopLossPrice.toFixed(2)}` : null,
          pos.takeProfitPrice ? `TP $${pos.takeProfitPrice.toFixed(2)}` : null,
        ].filter(Boolean).join(" · ");
        return `
          <div class="sim-pos-strip">
            <div>
              <span class="signal-pill ${pos.qty > 0 ? "bull" : "bear"}">${pos.qty > 0 ? "LONG" : "SHORT"} ${Math.abs(pos.qty).toFixed(2)}</span>
              <span class="mono muted-sm" style="margin-left:5px">@ $${pos.avgPrice.toFixed(2)}</span>
              ${slTp ? `<div class="mono muted" style="font-size:10px;margin-top:3px">${slTp}</div>` : ""}
            </div>
            <div class="mono ${cleanZero(uPnl) > 0 ? "pos" : cleanZero(uPnl) < 0 ? "neg" : ""}" style="text-align:right;font-weight:700">
              ${fmtMoney(uPnl)}
              <div style="font-size:10px">${fmtPct(uPct, 2, true)}</div>
            </div>
          </div>
        `;
      })()
    : `<div class="sim-pos-strip flat"><span class="muted-sm">Flat · Cash <strong class="mono">${fmtMoney(sim.cash)}</strong></span><span class="muted mono" style="font-size:10.5px">${sim.fillMode === "next_open" ? "Fills Next Open" : "Instant Close"}</span></div>`;

  const pendingHtml = sim.pendingOrder
    ? `
      <div class="sim-pending-chip mono">
        <span>⏳ QUEUED NEXT OPEN: <strong>${sim.pendingOrder.side.toUpperCase()} ${sim.pendingOrder.shares.toFixed(2)}</strong></span>
        <button class="btn-ghost-xs danger" id="simCancelPendingBtn">Cancel</button>
      </div>
    `
    : "";

  // 3. Scoreboard: YOU vs ARMED STRATEGY vs BUY & HOLD
  const scoreboardHtml = `
    <div class="sim-scoreboard">
      <div class="sim-score-tile primary">
        <span class="kpi-label">YOUR SIM</span>
        <strong class="mono ${cleanZero(stats.totalReturnPct) > 0 ? "pos" : cleanZero(stats.totalReturnPct) < 0 ? "neg" : ""}">${fmtPct(stats.totalReturnPct, 2, true)}</strong>
        <span class="mono muted" style="font-size:10px">${fmtMoney(stats.equity)} · ${stats.closedTotal ? `${fmtFixed(stats.winRatePct, 0)}% W (${stats.closedTotal})` : "0 closed"}</span>
      </div>
      <div class="sim-score-tile">
        <span class="kpi-label">STRATEGY</span>
        <strong class="mono ${cleanZero(stats.shadowReturnPct) > 0 ? "pos" : cleanZero(stats.shadowReturnPct) < 0 ? "neg" : ""}">${fmtPct(stats.shadowReturnPct, 2, true)}</strong>
        <span class="mono muted" style="font-size:10px">${plural(stats.shadowTrades, "trade")} · vs you ${fmtPct(stats.alphaVsStrategyPct, 1, true)}</span>
      </div>
      <div class="sim-score-tile">
        <span class="kpi-label">BUY &amp; HOLD</span>
        <strong class="mono ${cleanZero(stats.bhReturnPct) > 0 ? "pos" : cleanZero(stats.bhReturnPct) < 0 ? "neg" : ""}">${fmtPct(stats.bhReturnPct, 2, true)}</strong>
        <span class="mono muted" style="font-size:10px">α ${fmtPct(stats.alphaVsBhPct, 1, true)}</span>
      </div>
    </div>
  `;

  // 4. Tabbed Deep Inspection (Indicators | Journal | Edit Rules)
  let tabBodyHtml = "";
  if (simState.railTab === "indicators") {
    const markerPct = Math.max(2, Math.min(98, ((curScore + 100) / 200) * 100));
    const sellTickPct = ((thresholds.sell + 100) / 200) * 100;
    const buyTickPct = ((thresholds.buy + 100) / 200) * 100;

    // Consensus family dots
    let consHtml = "";
    if (tournament?.strategies?.length) {
      const strats = tournament.strategies;
      const summary = computeConsensusSummary(strats, idx);
      const eqScore = tournament.consensus?.equalScore?.[idx] ?? 0;
      const eqRating = classifyScore(eqScore, DEFAULT_THRESHOLDS);
      consHtml = `
        <div class="consensus-mini-box" style="margin-bottom:8px">
          <div class="consensus-mini-head">
            <span>24-STRATEGY CONSENSUS · ${summary.agreePct}% ALIGNED</span>
            <span class="signal-pill ${eqScore >= 18 ? "bull" : eqScore <= -18 ? "bear" : "flat"}">${eqRating.short}</span>
          </div>
          <div class="mono" style="font-size:11px;display:flex;justify-content:space-between">
            <span><span class="pos">${summary.bulls}▲</span> · <span class="muted">${summary.holds}—</span> · <span class="neg">${summary.bears}▼</span></span>
            ${forecast ? `<span class="${forecast.pUpPct >= 52 ? "pos" : forecast.pUpPct <= 48 ? "neg" : "muted"}">Forecast P(Up) ${forecast.pUpPct.toFixed(1)}%</span>` : ""}
          </div>
        </div>
      `;
    }

    const resMap = new Map((ruleResults || []).map((r) => [r.uid, r]));
    let rowsHtml = "";
    if (isEnsembleMode && tournament?.strategies?.length) {
      rowsHtml = tournament.strategies
        .slice(0, 10)
        .map((s) => {
          const sc = s.score?.[idx] ?? 0;
          const r = classifyScore(sc, s.thresholds);
          const barW = Math.min(50, Math.abs(sc) * 0.5);
          const barLeft = sc >= 0 ? 50 : 50 - barW;
          return `
            <div class="attr-row clickable" data-sim-pick-strat="${s.id}">
              <div class="attr-row-top">
                <span class="attr-name">#${s.rank} ${esc(s.name)}</span>
                <span class="signal-pill ${sc >= (s.thresholds?.buy ?? 18) ? "bull" : sc <= (s.thresholds?.sell ?? -18) ? "bear" : "flat"}">${r.short}</span>
              </div>
              <div class="attr-row-bot">
                <div class="strength-track"><div class="strength-zero"></div><div class="strength-fill ${sc >= 0 ? "pos" : "neg"}" style="left:${barLeft.toFixed(1)}%;width:${barW.toFixed(1)}%"></div></div>
                <span class="attr-contrib mono">${sc >= 0 ? "+" : ""}${sc.toFixed(0)}</span>
              </div>
            </div>
          `;
        })
        .join("");
    } else {
      let totalW = 0;
      for (const r of rules) if (r.enabled && r.mode !== 2) totalW += r.weight;
      rowsHtml = rules
        .filter((r) => r.enabled)
        .map((r) => {
          const meta = INDICATOR_BY_ID.get(r.indicatorId);
          const rr = resMap.get(r.uid);
          const rawSig = rr?.sig?.[idx] ?? 0;
          const sig = r.mode === 1
            ? (rawSig >= (r.triggerThresh ?? 0.35) ? 1 : rawSig <= -(r.triggerThresh ?? 0.35) ? -1 : 0)
            : rawSig;
          const valText = meta && rr?.lines ? meta.formatValue(rr.lines.map((arr) => arr[idx])) : "—";
          const contrib = r.mode === 2 ? 0 : totalW > 0 ? (sig * r.weight / totalW) * 100 : 0;
          const barW = Math.min(50, Math.abs(sig) * 50);
          const barLeft = sig >= 0 ? 50 : 50 - barW;
          const pill = r.mode === 2 ? (rawSig < -(r.vetoThresh ?? 0.25) ? "DAMPEN BUY" : rawSig > (r.vetoThresh ?? 0.25) ? "DAMPEN SELL" : "PASS")
            : sig > 0.45 ? "STR BULL" : sig > 0.12 ? "BULL" : sig < -0.45 ? "STR BEAR" : sig < -0.12 ? "BEAR" : "NEUTRAL";
          const cls = r.mode === 2 ? (pill === "PASS" ? "flat" : "veto") : sig > 0.12 ? "bull" : sig < -0.12 ? "bear" : "flat";
          return `
            <div class="attr-row">
              <div class="attr-row-top">
                <span class="attr-name">${esc(meta?.shortName || r.key)}</span>
                <span class="attr-val mono">${esc(valText)}</span>
                <span class="signal-pill ${cls}">${pill}</span>
              </div>
              <div class="attr-row-bot">
                <div class="strength-track"><div class="strength-zero"></div><div class="strength-fill ${sig >= 0 ? "pos" : "neg"}" style="left:${barLeft.toFixed(1)}%;width:${barW.toFixed(1)}%"></div></div>
                <span class="attr-contrib mono">${r.mode === 2 ? "VETO" : `${contrib >= 0 ? "+" : ""}${contrib.toFixed(1)}`}</span>
              </div>
            </div>
          `;
        })
        .join("");
    }

    tabBodyHtml = `
      <div class="card" style="padding:11px">
        <div class="decision-header" style="margin-bottom:6px">
          <div>
            <div class="decision-kicker">${esc(activeStrategyName)} · BAR ${idx + 1}</div>
            <div class="decision-verdict tone-${rating.tone}" style="font-size:18px">${rating.label}</div>
          </div>
          <div class="decision-score-box">
            <div class="decision-score mono" style="font-size:18px">${curScore >= 0 ? "+" : ""}${curScore.toFixed(1)}</div>
            <div class="decision-score-sub">SCORE</div>
          </div>
        </div>
        <div class="hbar-wrap" style="margin:6px 0 8px">
          <div class="hbar-track">
            <div class="hbar-tick" style="left:${sellTickPct}%"></div>
            <div class="hbar-tick center" style="left:50%"></div>
            <div class="hbar-tick" style="left:${buyTickPct}%"></div>
            <div class="hbar-marker" style="left:${markerPct}%"></div>
          </div>
        </div>
        ${consHtml}
        <div class="attr-list">${rowsHtml || `<div class="muted-sm">No active indicators.</div>`}</div>
      </div>
    `;
  } else if (simState.railTab === "journal") {
    const fillRows = sim.fills
      .slice(0, 40)
      .map(
        (f) => `
        <div class="sim-log-row">
          <div class="sim-log-top">
            <span class="signal-pill ${f.side === "buy" ? "bull" : "bear"}">${f.side.toUpperCase()} ${f.qty.toFixed(2)}</span>
            <span class="mono">@ $${f.price.toFixed(2)}</span>
            <span class="mono ${f.isClose ? (cleanZero(f.realizedPnl) > 0 ? "pos" : cleanZero(f.realizedPnl) < 0 ? "neg" : "muted") : "muted"}" style="margin-left:auto">
              ${f.isClose ? fmtMoney(f.realizedPnl) : "OPEN"}
            </span>
          </div>
          <div class="sim-log-sub mono muted">
            <span>${fmtBarTime(f.time, interval)} (Bar ${f.barIdx + 1})</span>
            <span>${esc(f.reason)}</span>
          </div>
        </div>
      `
      )
      .join("");
    const skipRows = sim.decisions
      .filter((d) => d.action === "skip")
      .slice(0, 12)
      .map(
        (d) => `
        <div class="sim-log-row skip">
          <div class="sim-log-top">
            <span class="signal-pill flat">IGNORED</span>
            <span class="muted-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.promptReason)}</span>
            <span class="mono muted" style="margin-left:auto">$${d.price.toFixed(2)}</span>
          </div>
        </div>
      `
      )
      .join("");
    tabBodyHtml = `
      <div class="card" style="padding:11px">
        <div class="section-mini-head">
          <span>SIMULATOR FILLS (${sim.fills.length})</span>
          <span class="mono ${cleanZero(stats.realizedPnl) > 0 ? "pos" : cleanZero(stats.realizedPnl) < 0 ? "neg" : "muted"}">Realized ${fmtMoney(stats.realizedPnl)}</span>
        </div>
        <div class="sim-log-list">${fillRows || `<div class="muted-sm" style="padding:14px;text-align:center">No simulated trades yet. Step bars or click Buy/Sell above!</div>`}</div>
        ${skipRows ? `<div class="section-mini-head" style="margin-top:12px"><span>IGNORED CO-PILOT PROMPTS</span></div><div class="sim-log-list">${skipRows}</div>` : ""}
      </div>
    `;
  }

  container.innerHTML = `
    ${promptHtml}
    <div class="card sim-trade-pad">
      <div class="section-mini-head" style="margin-bottom:7px">
        <span>DISCRETIONARY TRADE PAD · ${esc(symbol)}</span>
        <span class="mono" style="color:#f8fafc">$${markPx.toFixed(2)}</span>
      </div>
      ${posHtml}
      ${pendingHtml}
      <div class="sim-size-row">
        <span class="bar-tag">SIZE</span>
        <div class="cat-pills">${sizePills}</div>
        <label class="inline-check" style="margin-left:auto;font-size:10.5px">
          <input type="checkbox" id="simAllowShortCb" ${sim.allowShort ? "checked" : ""} />
          <span>Short</span>
        </label>
      </div>
      <div class="sim-bracket-row">
        <label><span>Stop-Loss %</span><input type="number" id="simSlInput" class="mono" placeholder="Off" min="0" max="50" step="0.5" value="${simState.stopLossPct || ""}" /></label>
        <label><span>Take-Profit %</span><input type="number" id="simTpInput" class="mono" placeholder="Off" min="0" max="200" step="0.5" value="${simState.takeProfitPct || ""}" /></label>
      </div>
      <div class="sim-trade-btns">
        <button class="btn-trade buy" id="simBuyBtn">Buy ${simState.sizePct}%</button>
        <button class="btn-trade sell" id="simSellBtn">${pos && pos.qty > 0 && !sim.allowShort ? `Sell ${simState.sizePct}%` : sim.allowShort ? `Sell/Short ${simState.sizePct}%` : `Sell`}</button>
        <button class="btn-ghost-sm" id="simFlattenBtn" ${!pos ? "disabled style=\"opacity:0.45\"" : ""}>Flatten</button>
      </div>
    </div>

    ${scoreboardHtml}

    <div class="rail-tabs sim-rail-tabs">
      <button class="rail-tab ${simState.railTab === "indicators" ? "active" : ""}" data-sim-tab="indicators">Indicators (${isEnsembleMode ? 24 : rules.filter((r) => r.enabled).length})</button>
      <button class="rail-tab ${simState.railTab === "journal" ? "active" : ""}" data-sim-tab="journal">Journal (${sim.fills.length})</button>
      <button class="rail-tab ${simState.railTab === "edit" ? "active" : ""}" data-sim-tab="edit">Edit Rules</button>
    </div>

    ${tabBodyHtml}
  `;

  container.querySelector("#simPromptAcceptBtn")?.addEventListener("click", () => onPromptAccept?.());
  container.querySelector("#simPromptSkipBtn")?.addEventListener("click", () => onPromptSkip?.());
  container.querySelector("#simPromptDismissBtn")?.addEventListener("click", () => onPromptDismiss?.());
  container.querySelector("#simBuyBtn")?.addEventListener("click", () => onUserTrade?.("buy"));
  container.querySelector("#simSellBtn")?.addEventListener("click", () => onUserTrade?.("sell"));
  container.querySelector("#simFlattenBtn")?.addEventListener("click", () => onUserTrade?.("flatten"));
  container.querySelector("#simCancelPendingBtn")?.addEventListener("click", () => onCancelPending?.());
  container.querySelectorAll("[data-sim-size]").forEach((b) =>
    b.addEventListener("click", () => onChangeSizePct?.(Number(b.dataset.simSize)))
  );
  container.querySelector("#simSlInput")?.addEventListener("change", (e) =>
    onUpdateBracket?.({ stopLossPct: Math.max(0, Number(e.target.value || 0)) })
  );
  container.querySelector("#simTpInput")?.addEventListener("change", (e) =>
    onUpdateBracket?.({ takeProfitPct: Math.max(0, Number(e.target.value || 0)) })
  );
  container.querySelector("#simAllowShortCb")?.addEventListener("change", (e) => onToggleAllowShort?.(e.target.checked));
  container.querySelectorAll("[data-sim-tab]").forEach((b) =>
    b.addEventListener("click", () => onChangeRailTab?.(b.dataset.simTab))
  );
  container.querySelectorAll("[data-sim-pick-strat]").forEach((el) =>
    el.addEventListener("click", () => onSwitchStrategy?.(el.dataset.simPickStrat))
  );
}
