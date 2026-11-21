import { loadDataSettings, saveDataSettings } from "../data/marketData.js";
import { classifyScore, DEFAULT_THRESHOLDS } from "../data/strategies.js";
import { fmtMoney, fmtFixed, fmtPct, smartTruncate, cleanZero } from "./format.js";

export function renderPaperDeskView(container, {
  symbol,
  currentPrice,
  activeStrategyName,
  activeScore,
  thresholds,
  tournament,
  portfolio,
  replayState,
  alpacaStatus,
  onSubmitOrder,
  onReconcileBroker,
  onPlacePending,
  onCancelPending,
  onFlattenPosition,
  onResetPortfolio,
  onToggleFlags,
  onReplayControl,
  onSaveSettings,
  onToggleLiveStream,
  onSelectTopStrategy,
  onOpenSimulator,
}) {
  const settings = loadDataSettings();
  const priceMap = { [symbol]: currentPrice };
  const eq = portfolio.getEquity(priceMap);
  const st = portfolio.state;

  const activeRating = classifyScore(activeScore ?? 0, thresholds);
  const consScore = tournament?.consensus?.equalScore?.at(-1) ?? 0;
  const consRating = classifyScore(consScore, DEFAULT_THRESHOLDS);
  const topRanked = tournament?.strategies?.[0];

  const posRows = Object.values(st.positions)
    .map((p) => {
      const px = priceMap[p.symbol] ?? p.lastPrice ?? p.avgPrice;
      const mv = p.qty * px;
      const uPnl = portfolio.getPositionUnrealizedPnl(p, px);
      const basis = Math.abs(p.avgPrice * p.qty) + (p.entryFeeRemaining || 0);
      const uPct = basis > 0 ? (uPnl / basis) * 100 : 0;
      return `
        <tr>
          <td><strong>${p.symbol}</strong> <span class="signal-pill ${p.qty > 0 ? "bull" : "bear"}">${p.qty > 0 ? "LONG" : "SHORT"}</span></td>
          <td class="mono">${Math.abs(p.qty).toFixed(2)}</td>
          <td class="mono">$${p.avgPrice.toFixed(2)}</td>
          <td class="mono">$${px.toFixed(2)}</td>
          <td class="mono">${fmtMoney(mv)}</td>
          <td class="mono ${cleanZero(uPnl) > 0 ? "pos" : cleanZero(uPnl) < 0 ? "neg" : ""}">${fmtMoney(uPnl)} (${fmtPct(uPct, 2, true)})</td>
          <td><button class="btn-ghost-xs" data-flatten="${p.symbol}">Flatten</button></td>
        </tr>
      `;
    })
    .join("");

  const pendingRows = st.pendingOrders
    .map(
      (o) => `
      <tr>
        <td><strong>${o.symbol}</strong></td>
        <td>
          <span class="signal-pill ${o.side === "buy" ? "bull" : "bear"}">${o.side.toUpperCase()} ${o.type.toUpperCase()}</span>
          ${o.role ? `<span class="cat-badge ${o.role === "sl" ? "cat-volatility" : "cat-trend"}" style="margin-left:4px">${o.role.toUpperCase()} · OCO</span>` : ""}
        </td>
        <td class="mono">${o.qty}</td>
        <td class="mono">$${o.limitPrice.toFixed(o.limitPrice < 1 ? 4 : 2)}</td>
        <td><button class="btn-ghost-xs danger" data-cancel-ord="${o.id}">${o.ocoGroupId ? "Cancel OCO" : "Cancel"}</button></td>
      </tr>
    `
    )
    .join("");

  const tradeRows = st.trades
    .slice(0, 40)
    .map((t) => {
      const bStat = t.brokerStatus || "local-sim";
      const bCls = bStat === "rejected" ? "bear" : bStat === "unknown" ? "veto" : bStat === "alpaca:filled" ? "bull" : "flat";
      return `
        <tr>
          <td class="mono muted">${new Date(t.time).toLocaleTimeString()}</td>
          <td><strong>${t.symbol}</strong></td>
          <td><span class="signal-pill ${t.side === "buy" ? "bull" : "bear"}">${t.side.toUpperCase()}</span></td>
          <td class="mono">${t.qty.toFixed(2)}</td>
          <td class="mono">$${t.price.toFixed(2)}</td>
          <td class="mono ${t.isClose ? (cleanZero(t.realizedPnl) > 0 ? "pos" : cleanZero(t.realizedPnl) < 0 ? "neg" : "") : "muted"}">${t.isClose ? fmtMoney(t.realizedPnl) : "—"}</td>
          <td><span class="reason-tag">${t.source}</span></td>
          <td><span class="signal-pill ${bCls}" title="${t.brokerError || (t.clientOrderId ? `client_order_id: ${t.clientOrderId}` : "")}">${bStat.toUpperCase()}</span></td>
        </tr>
      `;
    })
    .join("");

  const activeBrokerOrders = (st.brokerOrders || []).filter((o) => portfolio._needsReconcile(o));
  const brokerOrderRows = activeBrokerOrders
    .map(
      (o) => `
      <tr>
        <td class="mono">${o.clientOrderId}</td>
        <td><strong>${o.symbol}</strong></td>
        <td><span class="signal-pill ${o.side === "buy" ? "bull" : "bear"}">${o.side.toUpperCase()}</span></td>
        <td class="mono">${o.reconciledQty}/${o.qty}</td>
        <td><span class="signal-pill ${o.status === "unknown" ? "veto" : "flat"}">${o.status.toUpperCase()}</span></td>
      </tr>
    `
    )
    .join("");

  const suggestedSide = activeScore >= thresholds.buy ? "buy" : activeScore <= thresholds.sell ? "sell" : null;

  container.innerHTML = `
    <div class="bt-shell">
      <div class="paper-strategy-banner card">
        <div>
          <div class="decision-kicker">ARMED PAPER TRADING STRATEGY</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:3px;flex-wrap:wrap">
            <strong style="font-size:15px">${activeStrategyName || "Active Strategy"}</strong>
            <span class="signal-pill ${activeScore >= thresholds.buy ? "bull" : activeScore <= thresholds.sell ? "bear" : "flat"}">
              ${activeRating.label} (${activeScore >= 0 ? "+" : ""}${(activeScore ?? 0).toFixed(1)})
            </span>
            <span class="muted-sm mono">Consensus (${replayState.active ? "Causal Replay" : "Live"}): <strong>${consRating.short}</strong> (${consScore >= 0 ? "+" : ""}${consScore.toFixed(0)})</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${
            suggestedSide
              ? `<button class="btn-trade ${suggestedSide}" id="followSignalBtn" style="padding:7px 12px">⚡ Execute ${activeRating.label} ($10k)</button>`
              : `<button class="btn-ghost-sm" disabled style="opacity:0.6">Signal is HOLD</button>`
          }
          ${topRanked ? `<button class="btn-ghost-sm" id="armTop1Btn" title="Arm ${topRanked.name}">Arm #1 (${smartTruncate(topRanked.name, 20)})</button>` : ""}
          <button class="btn-ghost-sm" id="armConsensusBtn">Arm Consensus</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">PAPER EQUITY</span>
          <strong class="kpi-val mono">${fmtMoney(eq.equity)}</strong>
          <span class="kpi-sub mono ${cleanZero(eq.totalPnl) > 0 ? "pos" : cleanZero(eq.totalPnl) < 0 ? "neg" : ""}">${cleanZero(eq.totalPnl) > 0 ? "+" : ""}${fmtMoney(eq.totalPnl)} (${fmtPct(eq.totalPnlPct, 2, true)})</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">CASH / BUYING POWER</span>
          <strong class="kpi-val mono">${fmtMoney(eq.cash)}</strong>
          <span class="kpi-sub mono">Market Value ${fmtMoney(eq.marketValue)}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">UNREALIZED PNL</span>
          <strong class="kpi-val mono ${cleanZero(eq.unrealizedPnl) > 0 ? "pos" : cleanZero(eq.unrealizedPnl) < 0 ? "neg" : ""}">${fmtMoney(eq.unrealizedPnl)}</strong>
          <span class="kpi-sub mono">${Object.keys(st.positions).length} open position(s)</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">REALIZED PNL / WIN RATE</span>
          <strong class="kpi-val mono ${cleanZero(eq.realizedPnl) > 0 ? "pos" : cleanZero(eq.realizedPnl) < 0 ? "neg" : ""}">${fmtMoney(eq.realizedPnl)}</strong>
          <span class="kpi-sub mono">${eq.closedTotal > 0 ? `${fmtFixed(eq.winRatePct, 0)}% win (${eq.closedTotal} closed)` : "No closed trades yet"}</span>
        </div>
      </div>

      <div class="bt-two-col">
        <div class="card">
          <div class="section-mini-head">
            <span>ORDER TICKET · ${symbol} ($${currentPrice.toFixed(2)})</span>
            <div style="display:flex;align-items:center;gap:10px">
              <label class="inline-check" style="font-size:10.5px">
                <input type="checkbox" id="paperAllowShortCb" ${st.allowShort ? "checked" : ""} />
                <span>Allow Short</span>
              </label>
              <button class="btn-ghost-xs" id="resetPaperBtn">Reset $100k</button>
            </div>
          </div>
          <div class="ticket-grid">
            <label>
              <span>Order Type</span>
              <select id="ordType" class="full-select">
                <option value="market">Market</option>
                <option value="limit">Limit</option>
                <option value="stop">Stop</option>
              </select>
            </label>
            <label>
              <span>Quantity (Shares)</span>
              <input type="number" id="ordQty" class="mono" value="25" min="0.01" step="1" />
            </label>
            <label>
              <span>Limit / Stop Price ($)</span>
              <input type="number" id="ordPrice" class="mono" value="${currentPrice.toFixed(2)}" step="0.05" disabled title="Only active for Limit or Stop orders" />
            </label>
          </div>
          <div class="ticket-actions">
            <button class="btn-trade buy" id="ticketBuyBtn">Submit BUY ${symbol}</button>
            <button class="btn-trade sell" id="ticketSellBtn">Submit SELL ${symbol}</button>
          </div>
        </div>

        <div class="card">
          <div class="section-mini-head">
            <span>CAUSAL MARKET REPLAY (NEXT-BAR OPEN FILLS)</span>
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn-ghost-xs" id="openChartSimBtn" style="border-color:rgba(56,189,248,0.4);color:#7dd3fc">▶ Live-Chart Simulator →</button>
              <span class="mono ${replayState.active ? "pos" : "muted"}">${replayState.active ? `BAR ${replayState.cursor}/${replayState.total}` : "READY"}</span>
            </div>
          </div>
          <p class="muted-sm" style="margin:0 0 10px">
            Step bar-by-bar through historical data with strict causal consensus &amp; next-bar open auto-execution matching the WASM backtester.
          </p>
          <div class="replay-controls" style="margin-bottom:10px">
            <button class="btn-primary-sm" id="replayStartBtn">${replayState.active ? (replayState.playing ? "⏸ Pause" : "▶ Resume") : "▶ Start Replay"}</button>
            <button class="btn-ghost-sm" id="replayStepBtn">Step +1 Bar</button>
            <button class="btn-ghost-sm" id="replayExitBtn">Exit Replay</button>
            <select id="replaySpeed" class="mini-select">
              <option value="650" ${replayState.speedMs === 650 ? "selected" : ""}>1x</option>
              <option value="250" ${replayState.speedMs === 250 ? "selected" : ""}>3x</option>
              <option value="90" ${replayState.speedMs === 90 ? "selected" : ""}>8x</option>
            </select>
          </div>
          <label class="inline-check">
            <input type="checkbox" id="autoTradeCb" ${st.autoTrade ? "checked" : ""} />
            <span>Auto-Trade Active Strategy (queues on bar close → fills next-bar Open)</span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="section-mini-head">
          <span>OPEN POSITIONS</span>
          <span class="mono muted">${Object.keys(st.positions).length} ACTIVE</span>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Symbol</th><th>Qty</th><th>Avg Entry</th><th>Mark</th><th>Value</th><th>Unrealized</th><th></th></tr></thead>
            <tbody>${posRows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:16px">No open positions yet. Execute a signal above or start Replay Auto-Trade.</td></tr>`}</tbody>
          </table>
        </div>
      </div>

      ${
        activeBrokerOrders.length
          ? `<div class="card">
              <div class="section-mini-head">
                <span>UNRECONCILED ALPACA BROKER ORDERS (${activeBrokerOrders.length})</span>
                <button class="btn-primary-sm" id="reconcileBrokerBtn">Reconcile via client_order_id</button>
              </div>
              <div class="table-scroll">
                <table class="data-table">
                  <thead><tr><th>Client Order ID</th><th>Symbol</th><th>Side</th><th>Filled / Qty</th><th>Status</th></tr></thead>
                  <tbody>${brokerOrderRows}</tbody>
                </table>
              </div>
            </div>`
          : ""
      }

      ${
        st.pendingOrders.length
          ? `<div class="card">
              <div class="section-mini-head"><span>PENDING LIMIT / STOP ORDERS</span></div>
              <div class="table-scroll">
                <table class="data-table">
                  <thead><tr><th>Symbol</th><th>Order</th><th>Qty</th><th>Trigger Px</th><th></th></tr></thead>
                  <tbody>${pendingRows}</tbody>
                </table>
              </div>
            </div>`
          : ""
      }

      <div class="card">
        <div class="section-mini-head">
          <span>EXECUTION JOURNAL</span>
          <span class="mono muted">${st.trades.length} FILLS</span>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Fill Px</th><th>Realized PnL</th><th>Source</th><th>Broker</th></tr></thead>
            <tbody>${tradeRows || `<tr><td colspan="8" class="muted" style="text-align:center;padding:16px">No fills recorded yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>

      <!-- Collapsible Live Data & Broker Settings Drawer -->
      <details class="card settings-drawer">
        <summary class="settings-drawer-summary">
          <span>LIVE DATA &amp; ALPACA BYOK BROKER SETTINGS</span>
          <span class="signal-pill ${alpacaStatus === "live" ? "bull" : "flat"}">WS: ${alpacaStatus.toUpperCase()}</span>
        </summary>
        <p class="muted-sm" style="margin:10px 0">
          Keys stay strictly in browser <code>localStorage</code>. Connect free Alpaca Basic keys for &lt;1s real-time IEX WebSocket ticks &amp; Alpaca Paper API mirroring, or configure a Cloudflare Worker proxy URL.
        </p>
        <div class="settings-grid-3">
          <label><span>Alpaca API Key ID (BYOK)</span><input type="text" id="cfgAlpacaKey" class="mono" placeholder="PK..." value="${settings.alpacaKey || ""}" /></label>
          <label><span>Alpaca Secret Key</span><input type="password" id="cfgAlpacaSecret" class="mono" placeholder="••••••••" value="${settings.alpacaSecret || ""}" /></label>
          <label><span>Custom CORS Proxy Base URL</span><input type="text" id="cfgProxyBase" class="mono" placeholder="Default: local /api/market" value="${settings.proxyBase || ""}" /></label>
        </div>
        <div class="settings-actions" style="margin-top:10px">
          <label class="inline-check">
            <input type="checkbox" id="alpacaSyncCb" ${st.alpacaSync ? "checked" : ""} />
            <span>Mirror orders to Alpaca Paper API (surfaces rejections explicitly)</span>
          </label>
          <div style="display:flex;gap:8px">
            <button class="btn-primary-sm" id="saveSettingsBtn">Save Settings</button>
            <button class="btn-ghost-sm" id="toggleWsBtn">${alpacaStatus === "live" ? "Disconnect Stream" : "Connect Live WS"}</button>
          </div>
        </div>
      </details>
    </div>
  `;

  const submit = (side) => {
    const type = container.querySelector("#ordType").value;
    const qty = Number(container.querySelector("#ordQty").value);
    const limitPrice = Number(container.querySelector("#ordPrice").value);
    if (type === "market") onSubmitOrder?.({ symbol, side, qty, price: currentPrice, source: "manual" });
    else onPlacePending?.({ symbol, side, type, qty, limitPrice });
  };

  const ordTypeEl = container.querySelector("#ordType");
  const ordPriceEl = container.querySelector("#ordPrice");
  ordTypeEl?.addEventListener("change", () => {
    if (ordPriceEl) ordPriceEl.disabled = ordTypeEl.value === "market";
  });

  container.querySelector("#reconcileBrokerBtn")?.addEventListener("click", () => onReconcileBroker?.());
  container.querySelector("#ticketBuyBtn")?.addEventListener("click", () => submit("buy"));
  container.querySelector("#ticketSellBtn")?.addEventListener("click", () => submit("sell"));
  container.querySelector("#followSignalBtn")?.addEventListener("click", () => {
    if (!suggestedSide || currentPrice <= 0) return;
    const qty = Math.max(1, Math.round(10000 / currentPrice));
    onSubmitOrder?.({ symbol, side: suggestedSide, qty, price: currentPrice, source: `sig:${(activeStrategyName || "strat").slice(0, 14)}` });
  });
  container.querySelector("#armTop1Btn")?.addEventListener("click", () => topRanked && onSelectTopStrategy?.(topRanked.id));
  container.querySelector("#armConsensusBtn")?.addEventListener("click", () => onSelectTopStrategy?.("__consensus_equal__"));
  container.querySelector("#resetPaperBtn")?.addEventListener("click", () => onResetPortfolio?.());
  container.querySelector("#autoTradeCb")?.addEventListener("change", (e) => onToggleFlags?.({ autoTrade: e.target.checked }));
  container.querySelector("#paperAllowShortCb")?.addEventListener("change", (e) => onToggleFlags?.({ allowShort: e.target.checked }));
  container.querySelector("#alpacaSyncCb")?.addEventListener("change", (e) => onToggleFlags?.({ alpacaSync: e.target.checked }));
  container.querySelectorAll("[data-flatten]").forEach((b) => b.addEventListener("click", () => onFlattenPosition?.(b.dataset.flatten)));
  container.querySelectorAll("[data-cancel-ord]").forEach((b) => b.addEventListener("click", () => onCancelPending?.(b.dataset.cancelOrd)));
  container.querySelector("#replayStartBtn")?.addEventListener("click", () => onReplayControl?.("toggle"));
  container.querySelector("#replayStepBtn")?.addEventListener("click", () => onReplayControl?.("step"));
  container.querySelector("#replayExitBtn")?.addEventListener("click", () => onReplayControl?.("exit"));
  container.querySelector("#replaySpeed")?.addEventListener("change", (e) => onReplayControl?.("speed", Number(e.target.value)));

  container.querySelector("#saveSettingsBtn")?.addEventListener("click", () => {
    const next = {
      alpacaKey: container.querySelector("#cfgAlpacaKey").value.trim(),
      alpacaSecret: container.querySelector("#cfgAlpacaSecret").value.trim(),
      proxyBase: container.querySelector("#cfgProxyBase").value.trim(),
      alpacaFeed: "iex",
    };
    saveDataSettings(next);
    onSaveSettings?.(next);
  });
  container.querySelector("#openChartSimBtn")?.addEventListener("click", () => onOpenSimulator?.());
  container.querySelector("#toggleWsBtn")?.addEventListener("click", () => onToggleLiveStream?.());
}
