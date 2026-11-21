// Interactive Paper Trading Simulator Session Engine
// Strictly causal, isolated $100k discretionary training wallet + parallel mechanical strategy benchmark + smart Co-Pilot prompt triggers.

import { classifyScore, DEFAULT_THRESHOLDS } from "./strategies.js";
import { computeConsensusSummary } from "../ui/format.js";

export const SIM_PAUSE_MODES = [
  { id: "signal_change", label: "Pause on Signal Shift" },
  { id: "strong_only", label: "Pause on Strong Buy/Sell Only" },
  { id: "consensus", label: "Pause on ≥70% Consensus" },
  { id: "position_exit", label: "Pause on Actionable Entry/Exit" },
  { id: "manual", label: "Manual Stepping Only (No Auto-Pause)" },
];

export const SIM_TIME_PRESETS = [
  { id: "day_5m", label: "Intraday 5m", interval: "5m", range: "5d", title: "Simulate a full trading week at 5-minute intraday granularity" },
  { id: "day_15m", label: "Intraday 15m", interval: "15m", range: "1mo", title: "Simulate a month of intraday 15-minute bars" },
  { id: "swing_1h", label: "Hourly 1h", interval: "1h", range: "3mo", title: "Simulate 3 months of hourly bars" },
  { id: "daily_1y", label: "Daily 1Y", interval: "1d", range: "1y", title: "Simulate 1 year of daily trading sessions" },
  { id: "daily_2y", label: "Daily 2Y", interval: "1d", range: "2y", title: "Simulate 2 years of daily bars across market regimes" },
];

export class SimSession {
  constructor({ startingCash = 100000, feeBps = 1, slippageBps = 2, allowShort = false } = {}) {
    this.startingCash = startingCash;
    this.feeBps = feeBps;
    this.slippageBps = slippageBps;
    this.allowShort = allowShort;
    this.pauseMode = "signal_change";
    this.fillMode = "close"; // 'close' (instant) | 'next_open' (queue for next bar open)
    this.reset(startingCash);
  }

  reset(startingCash = this.startingCash, startCursor = 0, startPrice = 0) {
    this.startingCash = startingCash;
    this.startCursor = startCursor;
    this.startPrice = startPrice;
    this.cash = startingCash;
    this.position = null; // { qty, avgPrice, entryFeeRemaining, stopLossPrice, takeProfitPrice }
    this.pendingOrder = null; // { side, pctOrQty, mode: 'pct'|'shares', stopLossPct, takeProfitPct, queuedBarIdx }
    this.fills = [];
    this.decisions = [];
    this.lastPrompt = null;
    this.prevRatingId = null;
    this.prevConsensusDir = null;

    // Parallel mechanical benchmark following the armed strategy from the exact same startCursor
    this.shadow = {
      cash: startingCash,
      qty: 0,
      avgPrice: 0,
      entryFeeRemaining: 0,
      pendingSide: null, // 'buy' | 'sell' queued at bar close -> filled next bar open
      trades: 0,
    };
  }

  setStartAnchor(cursor, price) {
    this.startCursor = cursor;
    this.startPrice = price;
  }

  getStats(markPrice) {
    const px = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : this.position?.avgPrice || this.startPrice || 0;
    const mv = this.position ? this.position.qty * px : 0;
    const unrealizedPnl = this.position
      ? (px - this.position.avgPrice) * this.position.qty - (this.position.entryFeeRemaining || 0)
      : 0;
    const equity = this.cash + mv;
    const totalReturnPct = this.startingCash > 0 ? ((equity - this.startingCash) / this.startingCash) * 100 : 0;

    let realizedPnl = 0;
    let closedWins = 0;
    let closedTotal = 0;
    for (const f of this.fills) {
      if (f.isClose) {
        realizedPnl += f.realizedPnl;
        closedTotal++;
        if (f.realizedPnl > 0) closedWins++;
      }
    }
    const winRatePct = closedTotal > 0 ? (closedWins / closedTotal) * 100 : 0;

    // Shadow mechanical strategy stats
    const shadowEquity = this.shadow.cash + this.shadow.qty * px;
    const shadowReturnPct = this.startingCash > 0 ? ((shadowEquity - this.startingCash) / this.startingCash) * 100 : 0;

    // Buy & Hold benchmark over exact same revealed window
    const bhReturnPct = this.startPrice > 0 && px > 0 ? ((px - this.startPrice) / this.startPrice) * 100 : 0;

    return {
      equity,
      cash: this.cash,
      marketValue: mv,
      unrealizedPnl,
      realizedPnl,
      totalReturnPct,
      closedTotal,
      winRatePct,
      shadowEquity,
      shadowReturnPct,
      shadowTrades: this.shadow.trades,
      bhReturnPct,
      alphaVsStrategyPct: totalReturnPct - shadowReturnPct,
      alphaVsBhPct: totalReturnPct - bhReturnPct,
    };
  }

  executeOrder({ side, shares, price, barIdx, time, reason = "manual", stopLossPct = 0, takeProfitPct = 0 }) {
    const qty = Math.max(0, Number(shares));
    if (!Number.isFinite(qty) || qty <= 1e-8 || !Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid order quantity or price");
    }

    const slip = this.slippageBps / 10000;
    const feeRate = this.feeBps / 10000;
    const fillPx = side === "buy" ? price * (1 + slip) : price * (1 - slip);
    const fee = qty * fillPx * feeRate;
    const signedQty = side === "buy" ? qty : -qty;

    const existing = this.position || {
      qty: 0,
      avgPrice: fillPx,
      entryFeeRemaining: 0,
      stopLossPrice: null,
      takeProfitPrice: null,
    };

    let realizedPnl = 0;
    let isClose = false;

    if (existing.qty === 0 || Math.sign(existing.qty) === Math.sign(signedQty)) {
      if (signedQty < 0 && !this.allowShort && existing.qty === 0) {
        throw new Error("Shorting is disabled (enable Allow Shorting to open shorts)");
      }
      const newQty = existing.qty + signedQty;
      const newAvg = (Math.abs(existing.qty) * existing.avgPrice + Math.abs(signedQty) * fillPx) / Math.abs(newQty);
      existing.qty = newQty;
      existing.avgPrice = newAvg;
      existing.entryFeeRemaining = (existing.entryFeeRemaining || 0) + fee;
      if (stopLossPct > 0) {
        existing.stopLossPrice = newQty > 0 ? fillPx * (1 - stopLossPct / 100) : fillPx * (1 + stopLossPct / 100);
      }
      if (takeProfitPct > 0) {
        existing.takeProfitPrice = newQty > 0 ? fillPx * (1 + takeProfitPct / 100) : fillPx * (1 - takeProfitPct / 100);
      }
    } else {
      isClose = true;
      const absExisting = Math.abs(existing.qty);
      const closing = Math.min(absExisting, Math.abs(signedQty));
      const allocEntryFee = absExisting > 0 ? (existing.entryFeeRemaining || 0) * (closing / absExisting) : 0;
      const allocExitFee = fee * (closing / qty);
      const openRemFee = Math.max(0, fee - allocExitFee);

      realizedPnl = (fillPx - existing.avgPrice) * Math.sign(existing.qty) * closing - allocEntryFee - allocExitFee;
      existing.entryFeeRemaining = Math.max(0, (existing.entryFeeRemaining || 0) - allocEntryFee);

      const remaining = existing.qty + signedQty;
      if (Math.abs(remaining) < 1e-8) {
        existing.qty = 0;
        existing.avgPrice = 0;
        existing.entryFeeRemaining = 0;
        existing.stopLossPrice = null;
        existing.takeProfitPrice = null;
      } else if (Math.sign(remaining) !== Math.sign(existing.qty)) {
        if (remaining < 0 && !this.allowShort) {
          throw new Error("Shorting is disabled — use Flatten to close your long position");
        }
        existing.qty = remaining;
        existing.avgPrice = fillPx;
        existing.entryFeeRemaining = openRemFee;
        existing.stopLossPrice = stopLossPct > 0 ? (remaining > 0 ? fillPx * (1 - stopLossPct / 100) : fillPx * (1 + stopLossPct / 100)) : null;
        existing.takeProfitPrice = takeProfitPct > 0 ? (remaining > 0 ? fillPx * (1 + takeProfitPct / 100) : fillPx * (1 - takeProfitPct / 100)) : null;
      } else {
        existing.qty = remaining;
      }
    }

    this.cash -= signedQty * fillPx + fee;
    this.position = Math.abs(existing.qty) < 1e-8 ? null : existing;

    const fill = {
      id: `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      barIdx,
      time,
      side,
      qty,
      price: fillPx,
      fee,
      realizedPnl,
      isClose,
      reason,
    };
    this.fills.unshift(fill);
    if (this.fills.length > 200) this.fills.length = 200;
    return fill;
  }

  submitUserAction({ side, pct = 25, exactShares = null, price, barIdx, time, reason = "manual", stopLossPct = 0, takeProfitPct = 0 }) {
    const pos = this.position;
    let shares = exactShares;

    if (side === "flatten") {
      if (!pos || Math.abs(pos.qty) < 1e-8) return null;
      const closeSide = pos.qty > 0 ? "sell" : "buy";
      if (this.fillMode === "next_open") {
        this.pendingOrder = { side: closeSide, shares: Math.abs(pos.qty), reason: "flatten", stopLossPct: 0, takeProfitPct: 0, queuedBarIdx: barIdx };
        return { queued: true, order: this.pendingOrder };
      }
      return this.executeOrder({ side: closeSide, shares: Math.abs(pos.qty), price, barIdx, time, reason: "flatten" });
    }

    if (!Number.isFinite(shares) || shares <= 0) {
      if (side === "sell" && pos && pos.qty > 0 && !this.allowShort) {
        shares = Math.max(0.01, Number(((pos.qty * Math.min(100, pct)) / 100).toFixed(4)));
      } else {
        const eq = Math.max(0, this.getStats(price).equity);
        const budget = side === "buy" ? Math.min(this.cash * 0.998, eq * (pct / 100)) : eq * (pct / 100);
        shares = Math.max(1, Math.floor(budget / Math.max(0.01, price)));
      }
    }

    if (this.fillMode === "next_open") {
      this.pendingOrder = { side, shares, reason, stopLossPct, takeProfitPct, queuedBarIdx: barIdx };
      return { queued: true, order: this.pendingOrder };
    }

    return this.executeOrder({ side, shares, price, barIdx, time, reason, stopLossPct, takeProfitPct });
  }

  recordDecision({ barIdx, time, action, promptReason, stratLabel, price }) {
    this.decisions.unshift({ barIdx, time, action, promptReason, stratLabel, price });
    if (this.decisions.length > 200) this.decisions.length = 200;
  }

  // Called when advancing to a newly revealed bar:
  // 1) Executes any user queued Next-Bar-Open order at bar.o
  // 2) Checks user Stop-Loss / Take-Profit brackets against bar.h / bar.l
  // 3) Executes shadow mechanical benchmark queued signal at bar.o
  processNewBarOpenAndBrackets(bar, barIdx) {
    const events = [];

    // 1. User queued Next-Bar-Open order
    if (this.pendingOrder) {
      const ord = this.pendingOrder;
      this.pendingOrder = null;
      try {
        const fill = this.executeOrder({
          side: ord.side,
          shares: ord.shares,
          price: bar.o,
          barIdx,
          time: bar.t,
          reason: `${ord.reason} (next open)`,
          stopLossPct: ord.stopLossPct,
          takeProfitPct: ord.takeProfitPct,
        });
        events.push({ type: "queued_fill", fill });
      } catch (err) {
        events.push({ type: "queued_error", message: err.message });
      }
    }

    // 2. User SL / TP brackets (conservative: check SL first if both touched in same bar)
    if (this.position && Math.abs(this.position.qty) > 1e-8) {
      const p = this.position;
      const isLong = p.qty > 0;
      const hitSL = p.stopLossPrice != null && (isLong ? bar.l <= p.stopLossPrice : bar.h >= p.stopLossPrice);
      const hitTP = p.takeProfitPrice != null && (isLong ? bar.h >= p.takeProfitPrice : bar.l <= p.takeProfitPrice);
      if (hitSL || hitTP) {
        const triggerPx = hitSL ? p.stopLossPrice : p.takeProfitPrice;
        const fill = this.executeOrder({
          side: isLong ? "sell" : "buy",
          shares: Math.abs(p.qty),
          price: triggerPx,
          barIdx,
          time: bar.t,
          reason: hitSL ? "STOP LOSS" : "TAKE PROFIT",
        });
        events.push({ type: hitSL ? "stop_loss" : "take_profit", fill });
      }
    }

    // 3. Shadow mechanical strategy fills at bar.o (mirrors WASM backtester)
    if (this.shadow.pendingSide) {
      const side = this.shadow.pendingSide;
      this.shadow.pendingSide = null;
      const slip = this.slippageBps / 10000;
      const feeRate = this.feeBps / 10000;
      const fillPx = side === "buy" ? bar.o * (1 + slip) : bar.o * (1 - slip);
      if (side === "buy" && this.shadow.qty <= 0) {
        if (this.shadow.qty < 0) {
          // Close short first
          const coverNotional = Math.abs(this.shadow.qty) * fillPx;
          this.shadow.cash -= coverNotional + coverNotional * feeRate;
          this.shadow.qty = 0;
          this.shadow.trades++;
        }
        const avail = Math.max(0, this.shadow.cash);
        const fee = avail * feeRate;
        const netCap = Math.max(0, avail - fee);
        if (netCap > 0 && fillPx > 0) {
          this.shadow.qty = netCap / fillPx;
          this.shadow.avgPrice = fillPx;
          this.shadow.cash = 0;
        }
      } else if (side === "sell" && this.shadow.qty > 0) {
        const proceeds = this.shadow.qty * fillPx;
        const fee = proceeds * feeRate;
        this.shadow.cash += proceeds - fee;
        this.shadow.qty = 0;
        this.shadow.avgPrice = 0;
        this.shadow.trades++;
      }
    }

    return events;
  }

  // Called AFTER causal WASM evaluation on bars[0..barIdx]:
  // Updates shadow benchmark's next-bar-open queue and checks whether Co-Pilot should pause & prompt the user!
  evaluateBarSignal({ barIdx, bar, score, thresholds, tournamentStrategies, ruleResults = [], rules = [] }) {
    const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
    const rating = classifyScore(score, th);

    // Queue mechanical shadow strategy for next bar's Open
    if (score >= th.buy && this.shadow.qty <= 0) this.shadow.pendingSide = "buy";
    else if (score <= th.sell && this.shadow.qty > 0) this.shadow.pendingSide = "sell";

    // Compute causal consensus at this bar
    const cons = tournamentStrategies?.length ? computeConsensusSummary(tournamentStrategies, barIdx) : null;
    const consDir = cons ? (cons.bullPct >= 70 ? "bull" : cons.bearPct >= 70 ? "bear" : "flat") : "flat";

    const prevRating = this.prevRatingId;
    const prevConsDir = this.prevConsensusDir;
    this.prevRatingId = rating.id;
    this.prevConsensusDir = consDir;

    // On initial anchor bar (no previous rating yet), just prime state without popping a prompt
    if (prevRating === null) return null;

    if (this.pauseMode === "manual") return null;

    let prompt = null;
    const isBuyish = rating.id === "buy" || rating.id === "strong_buy";
    const isSellish = rating.id === "sell" || rating.id === "strong_sell";
    const posQty = this.position?.qty || 0;

    if (this.pauseMode === "signal_change") {
      if (rating.id !== prevRating && rating.id !== "hold") {
        prompt = {
          kind: isBuyish ? "buy" : "sell",
          headline: `Strategy Shift: ${prevRating.replace("_", " ").toUpperCase()} → ${rating.label}`,
          detail: `Score reached ${score >= 0 ? "+" : ""}${score.toFixed(1)}`,
        };
      }
    } else if (this.pauseMode === "strong_only") {
      if ((rating.id === "strong_buy" || rating.id === "strong_sell") && rating.id !== prevRating) {
        prompt = {
          kind: rating.id === "strong_buy" ? "buy" : "sell",
          headline: `High-Conviction ${rating.label}`,
          detail: `Score crossed extreme cutoff (${score >= 0 ? "+" : ""}${score.toFixed(1)})`,
        };
      }
    } else if (this.pauseMode === "consensus") {
      if (cons && consDir !== "flat" && consDir !== prevConsDir) {
        prompt = {
          kind: consDir === "bull" ? "buy" : "sell",
          headline: `Consensus Surge: ${cons.agreePct}% ${consDir === "bull" ? "Bullish" : "Bearish"}`,
          detail: `${cons.bulls}▲ / ${cons.holds}— / ${cons.bears}▼ across ${cons.total} strategies`,
        };
      }
    } else if (this.pauseMode === "position_exit") {
      if (isBuyish && posQty <= 0 && prevRating !== "buy" && prevRating !== "strong_buy") {
        prompt = {
          kind: "buy",
          headline: `Entry Setup: ${rating.label} (Currently ${posQty < 0 ? "SHORT" : "FLAT"})`,
          detail: `Strategy signals long entry at $${bar.c.toFixed(2)}`,
        };
      } else if (isSellish && posQty > 0 && prevRating !== "sell" && prevRating !== "strong_sell") {
        prompt = {
          kind: "sell",
          headline: `Exit Setup: ${rating.label} (Holding ${posQty.toFixed(2)} sh)`,
          detail: `Strategy signals closing long at $${bar.c.toFixed(2)}`,
        };
      }
    }

    if (!prompt) return null;

    // Extract top 3 indicator drivers for educational coaching!
    const drivers = [];
    const resMap = new Map((ruleResults || []).map((r) => [r.uid, r]));
    for (const rule of rules || []) {
      if (!rule.enabled) continue;
      const rr = resMap.get(rule.uid);
      const sigArr = rr?.sig || rr?.signal;
      if (!sigArr?.length) continue;
      const s = sigArr[barIdx] ?? 0;
      drivers.push({ key: rule.key, signal: s, contrib: s * rule.weight });
    }
    drivers.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));

    this.lastPrompt = {
      ...prompt,
      barIdx,
      time: bar.t,
      price: bar.c,
      score,
      rating,
      consensus: cons,
      drivers: drivers.slice(0, 3),
    };
    return this.lastPrompt;
  }
}
