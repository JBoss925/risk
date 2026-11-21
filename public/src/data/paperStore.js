// Local Persistent Paper Trading Portfolio
// Supports Market / Limit / Stop orders, shorting, exact net-of-commission realized/unrealized PnL,
// and idempotent Alpaca Paper broker reconciliation via client_order_id.

import { loadDataSettings } from "./marketData.js";

const STORAGE_KEY = "risk_paper_portfolio_v1";
const TERMINAL_BROKER_STATES = new Set(["filled", "canceled", "expired", "rejected", "not_found"]);

function createInitialState(startingCash = 100000) {
  return {
    startingCash,
    cash: startingCash,
    positions: {},
    pendingOrders: [],
    brokerOrders: [],
    trades: [],
    autoTrade: false,
    alpacaSync: false,
    feeBps: 1,
    slippageBps: 2,
  };
}

export class PaperPortfolio {
  constructor() {
    this.state = this._load();
    this.listeners = new Set();
    this._reconcileInFlight = null;
  }

  _needsReconcile(ord) {
    if (!ord) return false;
    if (!TERMINAL_BROKER_STATES.has(ord.status)) return true;
    return (ord.reportedFilledQty || 0) > (ord.reconciledQty || 0) + 1e-8;
  }

  _pruneBrokerOrders() {
    const unresolved = [];
    const terminal = [];
    for (const o of this.state.brokerOrders) {
      if (this._needsReconcile(o)) unresolved.push(o);
      else terminal.push(o);
    }
    this.state.brokerOrders = [...unresolved, ...terminal.slice(0, 50)];
  }

  _load() {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        const trades = Array.isArray(parsed.trades) ? parsed.trades : [];
        const brokerOrders = (Array.isArray(parsed.brokerOrders) ? parsed.brokerOrders : []).map((o) => {
          const recQty = Math.max(0, Number(o.reconciledQty || 0));
          const repQty = Math.max(Number(o.reportedFilledQty || 0), recQty);
          let recNotional =
            o.reconciledNotional !== null && o.reconciledNotional !== undefined && Number.isFinite(Number(o.reconciledNotional))
              ? Number(o.reconciledNotional)
              : NaN;
          if (!Number.isFinite(recNotional)) {
            if (recQty > 0) {
              // Recover exact prior notional ONLY when matching fill records unambiguously account for 100% of recQty.
              // If history rotated out or contains ambiguous legacy journal-only entries, leave NaN so reconciliation uses cumAvgPx safely.
              let sumNotional = 0;
              let sumQty = 0;
              let ambiguous = false;
              const ordQty = Number(o.qty || 0);
              for (const t of trades) {
                if (!t.clientOrderId || t.clientOrderId !== o.clientOrderId) continue;
                if (t.applied === false) continue;
                const tQty = Number(t.qty);
                const tPx = Number(t.price);
                if (t.applied === undefined) {
                  if (["rejected", "unknown", "alpaca:accepted", "alpaca:new", "alpaca:pending_new"].includes(t.brokerStatus)) continue;
                  // Legacy unpriced partial journal-only entries always recorded the full order qty at submittedPrice;
                  // a real partial fill never fills 100% of ordQty under status "partially_filled".
                  if (t.brokerStatus === "alpaca:partially_filled" && ordQty > 0 && Math.abs(tQty - ordQty) < 1e-6) continue;
                  if (t.brokerStatus !== "alpaca:filled" && t.brokerStatus !== "alpaca:partially_filled") {
                    ambiguous = true;
                    break;
                  }
                }
                if (!(tPx > 0 && tQty > 0)) {
                  ambiguous = true;
                  break;
                }
                sumNotional += tQty * tPx;
                sumQty += tQty;
              }
              recNotional = !ambiguous && Math.abs(sumQty - recQty) < 1e-6 ? sumNotional : NaN;
            } else {
              recNotional = 0;
            }
          }
          return { ...o, reconciledQty: recQty, reportedFilledQty: repQty, reconciledNotional: recNotional };
        });
        return { ...createInitialState(), ...parsed, trades, brokerOrders };
      }
    } catch {
      /* ignore */
    }
    return createInitialState();
  }

  _save() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      }
    } catch {
      /* ignore */
    }
    for (const fn of this.listeners) fn(this.state);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(startingCash = 100000) {
    this.state = createInitialState(startingCash);
    this._save();
  }

  setFlags(partial) {
    Object.assign(this.state, partial);
    this._save();
  }

  getEquity(priceMap = {}) {
    let marketValue = 0;
    let unrealizedPnl = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (!pos || Math.abs(pos.qty) < 1e-8) continue;
      const px = priceMap[pos.symbol] ?? pos.lastPrice ?? pos.avgPrice;
      pos.lastPrice = px;
      marketValue += pos.qty * px;
      unrealizedPnl += (px - pos.avgPrice) * pos.qty - (pos.entryFeeRemaining || 0);
    }
    let realizedPnl = 0;
    let closedWins = 0;
    let closedTotal = 0;
    for (const t of this.state.trades) {
      if (t.isClose || (t.isClose === undefined && t.realizedPnl)) {
        realizedPnl += t.realizedPnl || 0;
        closedTotal++;
        if ((t.realizedPnl || 0) > 0) closedWins++;
      }
    }
    const equity = this.state.cash + marketValue;
    const totalPnl = equity - this.state.startingCash;
    const totalPnlPct = (totalPnl / this.state.startingCash) * 100;
    const winRatePct = closedTotal > 0 ? (closedWins / closedTotal) * 100 : 0;
    return { equity, cash: this.state.cash, marketValue, unrealizedPnl, realizedPnl, closedTotal, winRatePct, totalPnl, totalPnlPct };
  }

  _applyLocalFill({ symbol, side, shares, fillPx, fee, source, brokerStatus, brokerError = null, clientOrderId = null }) {
    const signedQty = side === "buy" ? shares : -shares;
    const existing = this.state.positions[symbol] || {
      symbol,
      qty: 0,
      avgPrice: fillPx,
      lastPrice: fillPx,
      entryFeeRemaining: 0,
    };
    if (!Number.isFinite(existing.entryFeeRemaining)) existing.entryFeeRemaining = 0;

    let realizedPnl = 0;
    let isClose = false;

    if (existing.qty === 0 || Math.sign(existing.qty) === Math.sign(signedQty)) {
      const newQty = existing.qty + signedQty;
      const newAvg =
        (Math.abs(existing.qty) * existing.avgPrice + Math.abs(signedQty) * fillPx) / Math.abs(newQty);
      existing.qty = newQty;
      existing.avgPrice = newAvg;
      existing.entryFeeRemaining += fee;
    } else {
      isClose = true;
      const absExisting = Math.abs(existing.qty);
      const closing = Math.min(absExisting, Math.abs(signedQty));
      const allocEntryFee = absExisting > 0 ? existing.entryFeeRemaining * (closing / absExisting) : 0;
      const allocExitFee = shares > 0 ? fee * (closing / shares) : 0;
      const openRemainderFee = Math.max(0, fee - allocExitFee);

      realizedPnl = (fillPx - existing.avgPrice) * Math.sign(existing.qty) * closing - allocEntryFee - allocExitFee;
      existing.entryFeeRemaining = Math.max(0, existing.entryFeeRemaining - allocEntryFee);

      const remaining = existing.qty + signedQty;
      if (Math.abs(remaining) < 1e-8) {
        existing.qty = 0;
        existing.avgPrice = 0;
        existing.entryFeeRemaining = 0;
      } else if (Math.sign(remaining) !== Math.sign(existing.qty)) {
        existing.qty = remaining;
        existing.avgPrice = fillPx;
        existing.entryFeeRemaining = openRemainderFee;
      } else {
        existing.qty = remaining;
      }
    }

    existing.lastPrice = fillPx;
    this.state.cash -= signedQty * fillPx + fee;

    if (Math.abs(existing.qty) < 1e-8) delete this.state.positions[symbol];
    else this.state.positions[symbol] = existing;

    const trade = {
      id: `trd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      time: Date.now(),
      symbol,
      side,
      qty: shares,
      price: fillPx,
      fee,
      realizedPnl,
      isClose,
      applied: true,
      source,
      brokerStatus,
      brokerError,
      clientOrderId,
    };
    this.state.trades.unshift(trade);
    if (this.state.trades.length > 250) this.state.trades.length = 250;
    this._save();
    return trade;
  }

  _recordBrokerJournalOnly({ symbol, side, shares, price, source, brokerStatus, brokerError = null, clientOrderId = null }) {
    const entry = {
      id: `trd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      time: Date.now(),
      symbol,
      side,
      qty: shares,
      price,
      fee: 0,
      realizedPnl: 0,
      isClose: false,
      applied: false,
      source,
      brokerStatus,
      brokerError,
      clientOrderId,
    };
    this.state.trades.unshift(entry);
    if (this.state.trades.length > 250) this.state.trades.length = 250;
    this._save();
    return entry;
  }

  async submitMarketOrder({ symbol, side, qty, price, source = "manual" }) {
    const sym = symbol.toUpperCase();
    const shares = Math.max(0.0001, Number(qty));
    if (!Number.isFinite(shares) || !Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid quantity or price");
    }

    // Optional live Alpaca Paper Trading API mirror (BYOK):
    // Never treat HTTP acceptance as a fill, and never treat an unknown network error as a rejection!
    if (this.state.alpacaSync) {
      const cfg = loadDataSettings();
      const clientOrderId = `risk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      if (!cfg.alpacaKey || !cfg.alpacaSecret) {
        return this._recordBrokerJournalOnly({
          symbol: sym,
          side,
          shares,
          price,
          source,
          brokerStatus: "rejected",
          brokerError: "Alpaca API keys not configured",
          clientOrderId,
        });
      }

      try {
        const res = await fetch("https://paper-api.alpaca.markets/v2/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "APCA-API-KEY-ID": cfg.alpacaKey.trim(),
            "APCA-API-SECRET-KEY": cfg.alpacaSecret.trim(),
          },
          body: JSON.stringify({
            symbol: sym,
            qty: String(Number(shares.toFixed(4))),
            side,
            type: "market",
            time_in_force: "day",
            client_order_id: clientOrderId,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return this._recordBrokerJournalOnly({
            symbol: sym,
            side,
            shares,
            price,
            source,
            brokerStatus: "rejected",
            brokerError: body.message || `Alpaca HTTP ${res.status}`,
            clientOrderId,
          });
        }

        const rawStatus = String(body.status || "accepted").toLowerCase();
        const filledQty = Math.max(0, Number(body.filled_qty || 0));
        const filledAvgPx = Number(body.filled_avg_price || 0);

        const tracked = {
          brokerOrderId: body.id || null,
          clientOrderId: body.client_order_id || clientOrderId,
          symbol: sym,
          side,
          qty: shares,
          submittedPrice: price,
          source,
          status: rawStatus,
          reportedFilledQty: filledQty,
          reconciledQty: 0,
          reconciledNotional: 0,
          createdAt: Date.now(),
          error: null,
        };

        let fillRecord = null;
        if (filledQty > 0 && Number.isFinite(filledAvgPx) && filledAvgPx > 0) {
          tracked.reconciledQty = filledQty;
          tracked.reconciledNotional = filledQty * filledAvgPx;
          fillRecord = this._applyLocalFill({
            symbol: sym,
            side,
            shares: filledQty,
            fillPx: filledAvgPx,
            fee: 0,
            source,
            brokerStatus: `alpaca:${rawStatus}`,
            clientOrderId: tracked.clientOrderId,
          });
        }

        if (this._needsReconcile(tracked)) {
          this.state.brokerOrders.unshift(tracked);
          this._pruneBrokerOrders();
          this._save();
        }

        if (fillRecord) return fillRecord;

        return this._recordBrokerJournalOnly({
          symbol: sym,
          side,
          shares,
          price,
          source,
          brokerStatus: `alpaca:${rawStatus}`,
          brokerError: null,
          clientOrderId: tracked.clientOrderId,
        });
      } catch (err) {
        // Network failure: outcome on Alpaca is UNKNOWN (request may have reached broker).
        // Track by client_order_id so user can reconcile before retrying and avoid duplicate orders.
        const msg = err?.message || "Network error contacting Alpaca (outcome unknown — reconcile before retrying)";
        this.state.brokerOrders.unshift({
          brokerOrderId: null,
          clientOrderId,
          symbol: sym,
          side,
          qty: shares,
          submittedPrice: price,
          source,
          status: "unknown",
          reportedFilledQty: 0,
          reconciledQty: 0,
          reconciledNotional: 0,
          createdAt: Date.now(),
          error: msg,
        });
        this._pruneBrokerOrders();
        return this._recordBrokerJournalOnly({
          symbol: sym,
          side,
          shares,
          price,
          source,
          brokerStatus: "unknown",
          brokerError: msg,
          clientOrderId,
        });
      }
    }

    // Pure local simulation path (strictly applies slippage + commissions)
    const slip = this.state.slippageBps / 10000;
    const feeRate = this.state.feeBps / 10000;
    const fillPx = side === "buy" ? price * (1 + slip) : price * (1 - slip);
    const fee = shares * fillPx * feeRate;

    return this._applyLocalFill({
      symbol: sym,
      side,
      shares,
      fillPx,
      fee,
      source,
      brokerStatus: "local-sim",
    });
  }

  async reconcileBrokerOrders() {
    if (this._reconcileInFlight) return this._reconcileInFlight;
    this._reconcileInFlight = this._reconcileBrokerOrdersInner().finally(() => {
      this._reconcileInFlight = null;
    });
    return this._reconcileInFlight;
  }

  async _reconcileBrokerOrdersInner() {
    const cfg = loadDataSettings();
    if (!cfg.alpacaKey || !cfg.alpacaSecret) return { checked: 0, filled: 0, errors: ["Alpaca API keys not configured"] };

    let checked = 0;
    let filledCount = 0;
    const errors = [];

    for (const tracked of this.state.brokerOrders) {
      if (!this._needsReconcile(tracked)) continue;
      checked++;
      try {
        const url = `https://paper-api.alpaca.markets/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(tracked.clientOrderId)}`;
        const res = await fetch(url, {
          headers: {
            "APCA-API-KEY-ID": cfg.alpacaKey.trim(),
            "APCA-API-SECRET-KEY": cfg.alpacaSecret.trim(),
          },
        });
        if (res.status === 404) {
          if (tracked.status === "unknown") {
            tracked.status = "not_found";
            tracked.error = "Order never reached Alpaca (safe to retry)";
          }
          continue;
        }
        const ord = await res.json().catch(() => ({}));
        if (!res.ok) {
          errors.push(ord.message || `Alpaca HTTP ${res.status}`);
          continue;
        }

        tracked.brokerOrderId = ord.id || tracked.brokerOrderId;
        tracked.status = String(ord.status || tracked.status).toLowerCase();
        tracked.error = null;

        const totalFilled = Math.max(0, Number(ord.filled_qty || 0));
        tracked.reportedFilledQty = Math.max(tracked.reportedFilledQty || 0, totalFilled);
        const cumAvgPx = Number(ord.filled_avg_price || 0);
        const prevQty = tracked.reconciledQty || 0;
        const hasPrevNotional = prevQty === 0 || Number.isFinite(tracked.reconciledNotional);
        const prevNotional = prevQty === 0 ? 0 : tracked.reconciledNotional;
        const deltaFilled = totalFilled - prevQty;

        if (deltaFilled > 1e-8 && Number.isFinite(cumAvgPx) && cumAvgPx > 0) {
          const targetNotional = totalFilled * cumAvgPx;
          let incPx = cumAvgPx;
          if (hasPrevNotional) {
            const deltaNotional = targetNotional - prevNotional;
            if (deltaNotional > 0) incPx = deltaNotional / deltaFilled;
          }
          tracked.reconciledQty = totalFilled;
          tracked.reconciledNotional = targetNotional;
          filledCount++;
          this._applyLocalFill({
            symbol: tracked.symbol,
            side: tracked.side,
            shares: deltaFilled,
            fillPx: incPx,
            fee: 0,
            source: tracked.source,
            brokerStatus: `alpaca:${tracked.status}`,
            clientOrderId: tracked.clientOrderId,
          });
        }
      } catch (err) {
        errors.push(err?.message || "Network error reconciling order");
      }
    }

    this._pruneBrokerOrders();
    this._save();
    return { checked, filled: filledCount, errors };
  }

  placePendingOrder({ symbol, side, type, qty, limitPrice }) {
    const ord = {
      id: `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      symbol: symbol.toUpperCase(),
      side,
      type,
      qty: Number(qty),
      limitPrice: Number(limitPrice),
      createdAt: Date.now(),
    };
    this.state.pendingOrders.unshift(ord);
    this._save();
    return ord;
  }

  cancelPendingOrder(id) {
    this.state.pendingOrders = this.state.pendingOrders.filter((o) => o.id !== id);
    this._save();
  }

  async processBar(symbol, bar) {
    const sym = symbol.toUpperCase();
    const triggered = [];
    const remaining = [];
    for (const o of this.state.pendingOrders) {
      if (o.symbol !== sym) { remaining.push(o); continue; }
      const hitLimitBuy = o.type === "limit" && o.side === "buy" && bar.l <= o.limitPrice;
      const hitLimitSell = o.type === "limit" && o.side === "sell" && bar.h >= o.limitPrice;
      const hitStopBuy = o.type === "stop" && o.side === "buy" && bar.h >= o.limitPrice;
      const hitStopSell = o.type === "stop" && o.side === "sell" && bar.l <= o.limitPrice;
      if (hitLimitBuy || hitLimitSell || hitStopBuy || hitStopSell) triggered.push(o);
      else remaining.push(o);
    }
    if (triggered.length) {
      this.state.pendingOrders = remaining;
      this._save();
      for (const o of triggered) {
        await this.submitMarketOrder({ symbol: o.symbol, side: o.side, qty: o.qty, price: o.limitPrice, source: o.type });
      }
    }
  }
}
